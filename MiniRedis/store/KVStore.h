#pragma once
#include <unordered_map>
#include <string>
#include <list>
#include <mutex>
#include <chrono>
#include <queue>







class KVStore {
private:
    int capacity = 500;

    struct Node {
        std::string value;
        long long expiry;   // epoch time (ms), -1 = no expiry
        std::list<std::string>::iterator it;
    };

    std::priority_queue<
        std::pair<long long, std::string>,
        std::vector<std::pair<long long, std::string>>,
        std::greater<>
    > expiryHeap;

    std::unordered_map<std::string, Node> store;
    std::list<std::string> lru;

    std::mutex mtx;

    long long getCurrentTime();  // helper

public:
    void set(const std::string &key, const std::string &value, int ttl = -1); // updated
    void cleanExpired();
    void loadSnapshot();
    void saveSnapshot();
    int exists(const std::string &key);
    int ttl(const std::string &key);
    int incr(const std::string &key);
    int decr(const std::string &key);
    std::string get(const std::string &key);
    void del(const std::string &key);
};





