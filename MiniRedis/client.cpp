#include <iostream>
#include <arpa/inet.h>
#include <unistd.h>
#include <cstring>

using namespace std;

int main() {
    int sock = socket(AF_INET, SOCK_STREAM, 0);

    if (sock < 0) {
        perror("Socket creation failed");
        return 1;
    }

    sockaddr_in serv_addr;
    serv_addr.sin_family = AF_INET;
    serv_addr.sin_port = htons(8080);

    if (inet_pton(AF_INET, "127.0.0.1", &serv_addr.sin_addr) <= 0) {
        perror("Invalid address");
        return 1;
    }

    if (connect(sock, (struct sockaddr*)&serv_addr, sizeof(serv_addr)) < 0) {
        perror("Connection failed");
        return 1;
    }

    // Step 1: set short timeout
    struct timeval tv;
    tv.tv_sec = 1;
    tv.tv_usec = 0;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof tv);

    // Step 2: try reading server response first
    char buffer[1024];
    memset(buffer, 0, sizeof(buffer));

    int valread = recv(sock, buffer, 1024, 0);

    if (valread > 0) {
        string response(buffer, valread);

        if (response == "Server busy\n") {
            cout << "Server is busy. Try later.\n";
            close(sock);
            return 0;
        }
    }

    // Step 3: now safe to proceed
    cout << "Connected to server\n";

    // Step 4: send handshake
    string hello = "CLIENT\n";
    send(sock, hello.c_str(), hello.size(), 0);

    while (true) {
        cout << ">> ";
        string cmd;
        getline(cin, cmd);

        // ignore empty / whitespace input
        bool onlySpaces = true;
        for (char c : cmd) {
            if (!isspace(c)) {
                onlySpaces = false;
                break;
            }
        }
        if (onlySpaces) continue;

        if (cmd == "EXIT") {
            close(sock);
            break;
        }

        string msg = cmd + "\n";

        if (send(sock, msg.c_str(), msg.size(), 0) < 0) {
            perror("Send failed");
            break;
        }

        static string pending = "";

        while (true) {
            memset(buffer, 0, sizeof(buffer));
            int valread = recv(sock, buffer, 1024, 0);

            if (valread == 0) {
                cout << "Server disconnected\n";
                close(sock);
                return 0;
            }

            if (valread < 0) {
                perror("recv failed");
                close(sock);
                return 0;
            }

            string response(buffer, valread);

            if (response == "Server busy\n") {
                cout << "Server is busy. Try later.\n";
                close(sock);
                return 0;
            }

            pending += string(buffer, valread);

            size_t pos;
            while ((pos = pending.find('\n')) != string::npos) {
                string line = pending.substr(0, pos);
                pending.erase(0, pos + 1);
                cout << line << endl;
            }

            // break after at least one full response
            if (pending.empty()) break;
        }
    }

    return 0;
}



