CXX := g++
CXXFLAGS := -std=c++20 -Wall -Wextra -pedantic

SERVER_SOURCES := main.cpp \
	store/KVStore.cpp \
	parser/CommandParser.cpp \
	server/Server.cpp \
	utils/Logger.cpp

CLIENT_SOURCES := client.cpp

.PHONY: all clean run client

all: app client

app: $(SERVER_SOURCES)
	$(CXX) $(CXXFLAGS) $(SERVER_SOURCES) -o app

client: $(CLIENT_SOURCES)
	$(CXX) $(CXXFLAGS) $(CLIENT_SOURCES) -o client

run: app
	./app

clean:
	rm -f app client main
