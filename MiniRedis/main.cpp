#include "server/Server.h"
#include <string>

int main(int argc, char* argv[]) {
    Server server;

    if (argc == 3 && std::string(argv[1]) == "slave") {
        server.startAsSlave("127.0.0.1", std::stoi(argv[2]));
    } else {
        server.start(8080);
    }

    return 0;
}