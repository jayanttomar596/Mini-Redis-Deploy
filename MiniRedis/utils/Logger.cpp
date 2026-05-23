#include "Logger.h"


std::mutex Logger::log_mtx; 

void Logger::info(const string &msg) {
    std::lock_guard<std::mutex> lock(log_mtx); // Protect console output
    cout << "[INFO]  [" << getTime() << "] " << msg << endl;
}

void Logger::error(const string &msg) {
    std::lock_guard<std::mutex> lock(log_mtx); // Protect console output
    cout << "[ERROR] [" << getTime() << "] " << msg << endl;
}

void Logger::debug(const string &msg) {
    std::lock_guard<std::mutex> lock(log_mtx); // Protect console output
    cout << "[DEBUG] [" << getTime() << "] " << msg << endl;
}