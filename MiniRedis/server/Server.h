#pragma once
#include "../store/KVStore.h"
#include <vector>
#include <atomic>
#include <mutex>

class Server {
private:
    int server_fd;
    KVStore kv;
    std::vector<int> slave_sockets;
    std::mutex slave_mtx;

    int MAX_CLIENTS = 100;
    int current_clients = 0;

    std::atomic<bool> running{true};

    std::mutex client_mtx;
    std::mutex wal_mtx;

public:
    void start(int port);
    void startAsSlave(const std::string &ip, int port);
    void stop();
    bool isRunning();
};