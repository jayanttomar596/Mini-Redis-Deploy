#include "KVStore.h"
#include "../parser/CommandParser.h"

#include <fstream>
#include <string>
#include <vector>
#include <chrono>
#include <mutex>

using namespace std;


long long KVStore::getCurrentTime() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()
    ).count();
}




void KVStore::set(const std::string &key, const std::string &value, int ttl) {
    std::lock_guard<std::mutex> lock(mtx);

    long long expiry_time = -1;

    if (ttl != -1) {
        expiry_time = getCurrentTime() + ttl * 1000;
    }

    auto it = store.find(key);

    if (it != store.end()) {
        lru.erase(it->second.it);
    }
    else {
        // Step 1: Clean expired keys from LRU (from back)
        while (!lru.empty()) {
            std::string key_to_check = lru.back();
            auto it2 = store.find(key_to_check);

            if (it2 != store.end()) {
                long long expiry = it2->second.expiry;

                if (expiry != -1 && getCurrentTime() > expiry) {
                    lru.pop_back();
                    store.erase(it2);
                } else {
                    break; // stop at first valid key
                }
            } else {
                lru.pop_back();
            }
        }

        // Step 2: If still full → evict LRU
        if (store.size() >= capacity) {
            std::string lru_key = lru.back();
            lru.pop_back();
            store.erase(lru_key);
        }
    }

    lru.push_front(key);
    store[key] = {value, expiry_time, lru.begin()};

    if (expiry_time != -1) {
        expiryHeap.push({expiry_time, key});
    }
}





std::string KVStore::get(const std::string &key) {
    std::lock_guard<std::mutex> lock(mtx);

    auto it = store.find(key);

    if (it == store.end()) {
        return "NULL";
    }

    long long expiry = it->second.expiry;

    if (expiry != -1 && getCurrentTime() > expiry) {
        lru.erase(it->second.it);
        store.erase(it);
        return "NULL";
    }

    // move to front
    lru.erase(it->second.it);
    lru.push_front(key);
    it->second.it = lru.begin();

    return it->second.value;
}




void KVStore::del(const std::string &key) {
    std::lock_guard<std::mutex> lock(mtx);

    auto it = store.find(key);

    if (it != store.end()) {
        lru.erase(it->second.it);
        store.erase(it);
    }
}






void KVStore::cleanExpired() {
    std::lock_guard<std::mutex> lock(mtx);

    long long now = getCurrentTime();

    while (!expiryHeap.empty()) {
        auto [expiry, key] = expiryHeap.top();

        if (expiry > now) break;

        expiryHeap.pop();

        auto it = store.find(key);

        // skip if already deleted or updated
        if (it != store.end() && it->second.expiry == expiry) {
            lru.erase(it->second.it);
            store.erase(it);
        }
    }
}







void KVStore::saveSnapshot() {
    std::unordered_map<std::string, Node> store_copy;
    long long now = getCurrentTime();

    // STEP 1: The "Short-Lock"
    {
        std::lock_guard<std::mutex> lock(mtx);
        store_copy = store; // O(N) memory copy is extremely fast
    } // Lock is instantly destroyed and released here!

    // STEP 2: The Unlocked Disk Write
    // The main server can now continue processing clients while this writes to disk.
    ofstream file("snapshot.rdb");

    for (auto &p : store_copy) {
        const string &key = p.first;
        const string &value = p.second.value;
        long long expiry = p.second.expiry;

        if (expiry != -1 && expiry <= now) continue; 

        file << key << " " << value;

        if (expiry != -1) {
            int ttl = (expiry - now) / 1000;
            if (ttl > 0) {
                file << " EX " << ttl;
            }
        }

        file << "\n";
    }
}









void KVStore::loadSnapshot() {
    ifstream file("snapshot.rdb");
    if (!file.is_open()) return;
    string line;

    while (getline(file, line)) {
        vector<string> tokens = CommandParser::parse(line);

        if (tokens.size() == 2) {
            set(tokens[0], tokens[1], -1);
        }
        else if (tokens.size() == 4 && tokens[2] == "EX") {
            int ttl = stoi(tokens[3]);
            set(tokens[0], tokens[1], ttl);
        }
    }
}





int KVStore::exists(const std::string &key) {
    std::lock_guard<std::mutex> lock(mtx);

    auto it = store.find(key);

    if (it == store.end()) return 0;

    long long expiry = it->second.expiry;

    if (expiry != -1 && getCurrentTime() > expiry) {
        lru.erase(it->second.it);
        store.erase(it);
        return 0;
    }

    return 1;
}






int KVStore::ttl(const std::string &key) {
    std::lock_guard<std::mutex> lock(mtx);

    auto it = store.find(key);

    if (it == store.end()) return -2;

    long long expiry = it->second.expiry;

    if (expiry == -1) return -1;

    long long remaining = expiry - getCurrentTime();

    if (remaining <= 0) {
        lru.erase(it->second.it);
        store.erase(it);
        return -2;
    }

    return remaining / 1000;
}






int KVStore::incr(const std::string &key) {
    std::lock_guard<std::mutex> lock(mtx);

    auto it = store.find(key);

    if (it == store.end()) {
        lru.push_front(key);
        store[key] = {"1", -1, lru.begin()};
        return 1;
    }

    long long expiry = it->second.expiry;

    if (expiry != -1 && getCurrentTime() > expiry) {
        lru.erase(it->second.it);
        store.erase(it);

        lru.push_front(key);
        store[key] = {"1", -1, lru.begin()};
        return 1;
    }

    try {
        int val = stoi(it->second.value);
        val++;

        it->second.value = to_string(val);

        // move to front (LRU)
        lru.erase(it->second.it);
        lru.push_front(key);
        it->second.it = lru.begin();

        return val;
    } catch (...) {
        return INT_MIN; // error
    }
}




int KVStore::decr(const std::string &key) {
    std::lock_guard<std::mutex> lock(mtx);

    auto it = store.find(key);

    if (it == store.end()) {
        lru.push_front(key);
        store[key] = {"-1", -1, lru.begin()};
        return -1;
    }

    long long expiry = it->second.expiry;

    if (expiry != -1 && getCurrentTime() > expiry) {
        lru.erase(it->second.it);
        store.erase(it);

        lru.push_front(key);
        store[key] = {"-1", -1, lru.begin()};
        return -1;
    }

    try {
        int val = stoi(it->second.value);
        val--;

        it->second.value = to_string(val);

        lru.erase(it->second.it);
        lru.push_front(key);
        it->second.it = lru.begin();

        return val;
    } catch (...) {
        return INT_MIN;
    }
}

















