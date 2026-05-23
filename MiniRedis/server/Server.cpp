#include "Server.h"
#include "../parser/CommandParser.h"

#include <iostream>
#include <fstream>
#include <csignal>
#include <vector>
#include <sys/socket.h>
#include <cerrno>
#include <cstring>
#include <thread>
#include <mutex>
#include <chrono>
#include <unistd.h>
#include <arpa/inet.h>
#include "../utils/Logger.h"

using namespace std;


Server* global_server = nullptr;



// Signal Handler



void Server::stop() {
    running = false;
    close(server_fd);
}

bool Server::isRunning() {
    return running;
}


void signalHandler(int signum) {
    Logger::info("Shutting down server...");

    if (global_server) {
        global_server->stop(); // IMPORTANT
    }
}





void loadData(KVStore &kv) {
    std::ifstream file("data.log");
    std::string line;

    while (getline(file, line)) {
        std::vector<std::string> tokens = CommandParser::parse(line);

        if (tokens.empty()) continue;
  
        // skip incomplete/corrupted commands
        if (tokens[0] == "SET") {
            if (tokens.size() == 3) { }
            else if (tokens.size() == 5 && tokens[3] == "EX") { }
            else {
                continue;
            }
        }
        if (tokens[0] == "DEL" && tokens.size() != 2) {
            continue;
        }

        if (tokens.size() >= 1 && tokens[0] == "SET") {
            if (tokens.size() == 5 && tokens[3] == "EX") {
                int ttl;
                try {
                    ttl = stoi(tokens[4]);
                } catch (...) {
                    continue;
                }
                kv.set(tokens[1], tokens[2], ttl);
            }
            else if (tokens.size() == 3) {
                kv.set(tokens[1], tokens[2]);
            }
        }
        else if (tokens.size() == 2 && tokens[0] == "DEL") {
            kv.del(tokens[1]);
        }
    }
}







void handleClient(int client_socket,
                  KVStore &kv,
                  vector<int> &slaves,
                  std::mutex &slave_mtx,
                  int &current_clients,
                  std::mutex &client_mtx,
                std::mutex &wal_mtx) {
    bool is_slave = false;
    bool identified = false; 
    char buffer[1024];
    string pending = "";

    while (global_server->isRunning()) {
        memset(buffer, 0, sizeof(buffer));

        int valread = recv(client_socket, buffer, 1024, 0);

        if (valread == 0) {
            if (is_slave) Logger::info("Slave disconnected");
            else Logger::info("Client disconnected");


        {
            std::lock_guard<std::mutex> lock(client_mtx);
            current_clients--;
        }

        close(client_socket);
        break;
    }
        if (valread < 0) {
            Logger::error("recv failed: " + string(strerror(errno)));

            if (is_slave) Logger::info("Slave disconnected");
            else Logger::info("Client disconnected");

            {
                std::lock_guard<std::mutex> lock(client_mtx);
                current_clients--;
            }

            close(client_socket);
            break;
        }

        pending += string(buffer, valread);

        

        size_t pos;
        while ((pos = pending.find('\n')) != string::npos) {
            string line = pending.substr(0, pos);

            pending.erase(0, pos + 1);

            // HANDLE HANDSHAKE FIRST
            if (!identified) {
                if (line == "SLAVE") {
                    {
                        std::lock_guard<std::mutex> lock(slave_mtx);
                        slaves.push_back(client_socket);
                    }

                    is_slave = true;
                    Logger::info("Slave connected");

                    // 🔥 STEP 2: SEND SNAPSHOT
                    ifstream file("snapshot.rdb");

                    if (file.is_open()) {
                        string snapshot_data = "SNAPSHOT_START\n";
                        string snap_line;

                        while (getline(file, snap_line)) {
                            snapshot_data += snap_line + "\n";
                        }

                        snapshot_data += "SNAPSHOT_END\n";

                        send(client_socket, snapshot_data.c_str(), snapshot_data.size(), 0);
                    }

                    identified = true;
                    continue;
                }
                else if (line == "CLIENT") {
                    // cout << "Client connected\n";
                    Logger::info("Client connected: socket " + to_string(client_socket));
                }
                else {
                    // fallback if no handshake
                    Logger::info("Unknown connection, treating as client");
                }

                identified = true;
                continue;
            }


            if (!line.empty() && line.back() == '\r') {
                line.pop_back();
            }

            vector<string> tokens = CommandParser::parse(line);

            if (tokens.empty()) continue;

            string response;


            if (tokens.size() >= 1 && tokens[0] == "SET") {

                bool is_valid = false;

                if (tokens.size() == 5 && tokens[3] == "EX") {
                    int ttl;
                    try {
                        ttl = stoi(tokens[4]);
                    } catch (...) {
                        response = "Invalid TTL\n";
                        send(client_socket, response.c_str(), response.size(), 0);
                        continue;
                    }
                    kv.set(tokens[1], tokens[2], ttl);
                    if (!is_slave) {
                        std::lock_guard<std::mutex> lock(wal_mtx); // Protect file IO
                        ofstream file("data.log", ios::app);
                        file << line << "\n";
                    }

                    Logger::debug("SET " + tokens[1] + " " + tokens[2] + " EX " + tokens[4]);
                    response = "OK\n";

                    is_valid = true; 
                }
                else if (tokens.size() == 3) {
                    kv.set(tokens[1], tokens[2]);

                    if (!is_slave) {
                        std::lock_guard<std::mutex> lock(wal_mtx); // Protect file IO
                        ofstream file("data.log", ios::app);
                        file << line << "\n";
                    }

                    Logger::debug("SET " + tokens[1] + " " + tokens[2]);
                    response = "OK\n";
                    is_valid = true; 
                }
                else {
                    response = "Invalid Command\n";
                }

                // FORWARD TO SLAVES
                if (!is_slave && is_valid) {
                    {
                        std::lock_guard<std::mutex> lock(slave_mtx);
                        std::string msg = line + "\n";
                        for (auto it = slaves.begin(); it != slaves.end(); ) {
                            int s = *it;
                            if (send(s, msg.c_str(), msg.size(), 0) < 0) {
                                close(s);  // close dead socket
                                it = slaves.erase(it);  // remove safely
                            } else {
                                ++it;
                            }
                        }
                    }
                }
            }
            else if (tokens.size() == 2 && tokens[0] == "GET") {
                response = kv.get(tokens[1]) + "\n";
            }
            else if (tokens.size() == 2 && tokens[0] == "DEL") {
                bool is_valid = true; 
                kv.del(tokens[1]);
                if (!is_slave) {
                    std::lock_guard<std::mutex> lock(wal_mtx); // Protect file IO
                    ofstream file("data.log", ios::app);
                    file << line << "\n";
                }

                Logger::debug("DEL " + tokens[1]);
                response = "Deleted\n";

                // FORWARD
                if (!is_slave && is_valid) {
                    {
                        std::lock_guard<std::mutex> lock(slave_mtx);
                        std::string msg = line + "\n";
                        for (auto it = slaves.begin(); it != slaves.end(); ) {
                            int s = *it;
                            if (send(s, msg.c_str(), msg.size(), 0) < 0) {
                                close(s);  // close dead socket
                                it = slaves.erase(it);  // remove safely
                            } else {
                                ++it;
                            }
                        }
                    }
                }
            }
            else if (tokens.size() == 2 && tokens[0] == "EXISTS") {
                int res = kv.exists(tokens[1]);
                response = to_string(res) + "\n";
            }
            else if (tokens.size() == 2 && tokens[0] == "TTL") {
                int res = kv.ttl(tokens[1]);
                response = to_string(res) + "\n";
            }
            else if (tokens.size() == 2 && tokens[0] == "INCR") {
                int res = kv.incr(tokens[1]);

                if (res == INT_MIN) {
                    response = "ERROR: Not an integer\n";
                } else {
                    response = to_string(res) + "\n";

                    if (!is_slave) {
                        std::lock_guard<std::mutex> lock(wal_mtx); // Protect file IO
                        ofstream file("data.log", ios::app);
                        file << line << "\n";
                    }

                    if (!is_slave) {
                        std::lock_guard<std::mutex> lock(slave_mtx);
                        std::string msg = line + "\n";

                        for (auto it = slaves.begin(); it != slaves.end(); ) {
                            int s = *it;
                            if (send(s, msg.c_str(), msg.size(), 0) < 0) {
                                close(s);
                                it = slaves.erase(it);
                            } else {
                                ++it;
                            }
                        }
                    }
                }
            }
            else if (tokens.size() == 2 && tokens[0] == "DECR") {
                int res = kv.decr(tokens[1]);

                if (res == INT_MIN) {
                    response = "ERROR: Not an integer\n";
                } else {
                    response = to_string(res) + "\n";

                    if (!is_slave) {
                        std::lock_guard<std::mutex> lock(wal_mtx); // Protect file IO
                        ofstream file("data.log", ios::app);
                        file << line << "\n";
                    }

                    if (!is_slave) {
                        std::lock_guard<std::mutex> lock(slave_mtx);
                        std::string msg = line + "\n";

                        for (auto it = slaves.begin(); it != slaves.end(); ) {
                            int s = *it;
                            if (send(s, msg.c_str(), msg.size(), 0) < 0) {
                                close(s);
                                it = slaves.erase(it);
                            } else {
                                ++it;
                            }
                        }
                    }
                }
            }
            else {
                response = "Invalid Command\n";
            }

            send(client_socket, response.c_str(), response.size(), 0);
        }
    }
}







void Server::start(int port) {
    global_server = this;
    signal(SIGINT, signalHandler);
    signal(SIGPIPE, SIG_IGN);
    server_fd = socket(AF_INET, SOCK_STREAM, 0);

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    if (server_fd < 0) {
        perror("Socket failed");
        return;
    }

    sockaddr_in address;
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = INADDR_ANY;
    address.sin_port = htons(port);

    if (::bind(server_fd, (struct sockaddr*)&address, sizeof(address)) < 0) 
    {
        perror("Bind failed");
        return;
    }

    if (listen(server_fd, SOMAXCONN) < 0) {
        perror("Listen failed");
        return;
    }

    kv.loadSnapshot();
    loadData(kv);

    thread cleaner([this]() {
        while (isRunning()) {
            this->kv.cleanExpired();
            this_thread::sleep_for(chrono::seconds(2));
        }
    });
    cleaner.detach();


    thread snapshotThread([this]() {
        while (isRunning()) {
            {
                std::lock_guard<std::mutex> lock(this->wal_mtx);
                ofstream clearFile("data.log", ios::trunc); 
            }
            this->kv.saveSnapshot();
            this_thread::sleep_for(chrono::seconds(10));
        }
    });
    snapshotThread.detach();

    // cout << "Server started on port " << port << endl;
    Logger::info("Server started on port " + to_string(port));

    // int addrlen = sizeof(address);

    while (isRunning()) {
        sockaddr_in client_addr;
        socklen_t addrlen = sizeof(client_addr);

        int client_socket = accept(server_fd, (struct sockaddr*)&client_addr, &addrlen);

        if (client_socket < 0) {
            if (!isRunning()) {
                break;  // shutdown triggered
            }

            if (errno == EINTR) {
                continue;  // interrupted by signal → retry
            }

            Logger::error("Accept failed: " + string(strerror(errno)));
            continue;
        }

        {
            std::lock_guard<std::mutex> lock(client_mtx);

            if (current_clients >= MAX_CLIENTS) {
                string msg = "Server busy\n";
                send(client_socket, msg.c_str(), msg.size(), 0);

                // ensure message is delivered
                shutdown(client_socket, SHUT_WR);  

                // small delay (optional but safe)
                // usleep(100000);  // 100 ms

                close(client_socket);
                continue;
            }

            current_clients++;
        }


        // cout << "Client connected\n";

        // create thread
        thread t([this, client_socket]() {
            handleClient(client_socket,
             this->kv,
             this->slave_sockets,
             this->slave_mtx,
             this->current_clients,
             this->client_mtx,
             this->wal_mtx);
        });
        t.detach();
    }

    Logger::info("Server stopped cleanly");
}











void Server::startAsSlave(const std::string &ip, int port) {
    bool loading_snapshot = false;

    int sock = socket(AF_INET, SOCK_STREAM, 0);

    sockaddr_in serv_addr;
    serv_addr.sin_family = AF_INET;
    serv_addr.sin_port = htons(port);
    inet_pton(AF_INET, ip.c_str(), &serv_addr.sin_addr);

    if (connect(sock, (struct sockaddr*)&serv_addr, sizeof(serv_addr)) < 0) {
        perror("Connection failed");
        return;
    }

    cout << "Connected to master\n";

    // REGISTER
    send(sock, "SLAVE\n", 6, 0);

    char buffer[1024];
    string pending = "";

    while (true) {
        int valread = recv(sock, buffer, 1024, 0);

        if (valread <= 0) {
            cout << "Master disconnected\n";
            break;
        }

        pending += string(buffer, valread);

        size_t pos;
        while ((pos = pending.find('\n')) != string::npos) {

            string line = pending.substr(0, pos);
            pending.erase(0, pos + 1);

            if (line == "SNAPSHOT_START") {
                loading_snapshot = true;
                continue;
            }

            if (line == "SNAPSHOT_END") {
                loading_snapshot = false;
                cout << "[SLAVE] Snapshot loaded\n";
                continue;
            }

            vector<string> tokens = CommandParser::parse(line);

            if (tokens.empty()) continue;



            if (loading_snapshot) {
                if (tokens.size() == 2) {
                    kv.set(tokens[0], tokens[1]);
                }
                else if (tokens.size() == 4 && tokens[2] == "EX") {
                    int ttl = stoi(tokens[3]);
                    kv.set(tokens[0], tokens[1], ttl);
                }
                continue;
            }


            if (tokens.size() >= 1 && tokens[0] == "SET") {
                if (tokens.size() == 5 && tokens[3] == "EX") {
                    int ttl;
                    try {
                        ttl = stoi(tokens[4]);
                    } catch (...) {
                        continue;
                    }
                    kv.set(tokens[1], tokens[2], ttl);
                }
                else if (tokens.size() == 3) {
                    kv.set(tokens[1], tokens[2]);
                }
                if (tokens.size() == 5 && tokens[3] == "EX") {
                    cout << "[SLAVE] SET " << tokens[1] << " = " << tokens[2] 
                        << " EX " << tokens[4] << endl;
                } else {
                    cout << "[SLAVE] SET " << tokens[1] << " = " << tokens[2] << endl;
                } // Just to check working 
            }
            else if (tokens[0] == "DEL") {
                kv.del(tokens[1]);
                cout << "[SLAVE] DEL " << tokens[1] << endl; // Just to check working
            }
            else if (tokens[0] == "INCR") {
                int val = kv.incr(tokens[1]);
                cout << "[SLAVE] INCR " << tokens[1] << " → " << val << endl;
            }
            else if (tokens[0] == "DECR") {
                int val = kv.decr(tokens[1]);
                cout << "[SLAVE] DECR " << tokens[1] << " → " << val << endl;
            }
        }
    }
}












