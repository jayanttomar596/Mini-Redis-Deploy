#pragma once
#include <iostream>
#include <string>
#include <chrono>
#include <ctime>
#include <mutex>

using namespace std;

class Logger {
private:
    static std::mutex log_mtx;
    static string getTime() {
        auto now = chrono::system_clock::now();
        time_t now_time = chrono::system_clock::to_time_t(now);

        string t = ctime(&now_time);
        t.pop_back(); // remove newline
        return t;
    }

public:
    static void info(const string &msg) ;

    static void error(const string &msg) ;

    static void debug(const string &msg) ;
    
};