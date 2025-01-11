const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const port = 3111;

const gameRooms = new Map();

function debugLog(roomName, message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}][Room: ${roomName}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

class GameRoom {
    constructor(roomName) {
        this.roomName = roomName;
        this.players = new Map();
        this.killer = null;
        this.isRoulettePlaying = false;
        this.eliminatedPlayers = new Set();
        this.currentSelection = null;
        this.rouletteInterval = null;
        debugLog(roomName, 'Room created');
    }

    assignInitialKiller() {
        const players = Array.from(this.players.keys());
        this.killer = players[Math.floor(Math.random() * players.length)];
        debugLog(this.roomName, `Initial killer assigned`, { killer: this.killer });
        return this.killer;
    }

    addPlayer(socketId, playerName) {
        this.players.set(socketId, {
            name: playerName,
            eliminated: false,
            isReady: true
        });
    }

    removePlayer(socketId) {
        if (this.players.has(socketId)) {
            this.players.delete(socketId);
            return true;
        }
        return false;
    }

    getAliveCount() {
        return Array.from(this.players.values()).filter(p => !p.eliminated).length;
    }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
    socket.on('joinRoom', ({room}) => {
        if (!room) return;
        
        socket.join(room);
        if (!gameRooms.has(room)) {
            gameRooms.set(room, new GameRoom(room));
        }
        socket.emit('roomJoined', room);
    });

    socket.on('setName', ({room, name}) => {
        const gameRoom = gameRooms.get(room);
        if (!gameRoom) return;

        gameRoom.addPlayer(socket.id, name);

        if (gameRoom.players.size === 1) {
            socket.emit('showStartButton');
        }

        updatePlayersInRoom(room);
    });

    socket.on('startGame', ({room}) => {
        const gameRoom = gameRooms.get(room);
        if (!gameRoom || gameRoom.players.size < 2) return;

        const initialKiller = gameRoom.assignInitialKiller();
        io.to(initialKiller).emit('youAreKiller');
        io.to(room).emit('gameStarted');
        
        setTimeout(() => startRoulette(room), 1000);
    });

    socket.on('accusation', ({room, target}) => {
        const gameRoom = gameRooms.get(room);
        if (!gameRoom || !gameRoom.currentSelection) return;

        const accusedPlayerId = Array.from(gameRoom.players.entries())
            .find(([_, p]) => p.name === target)?.[0];

        if (accusedPlayerId === gameRoom.killer) {
            const oldKillerName = gameRoom.players.get(gameRoom.killer).name;
            const newKillerName = gameRoom.players.get(socket.id).name;
            gameRoom.killer = socket.id;
            
            debugLog(room, 'Correct accusation - new killer assigned', {
                oldKiller: oldKillerName,
                newKiller: newKillerName
            });

            io.to(room).emit('systemMessage', `${newKillerName} correctly identified ${oldKillerName} as the killer and is now the new killer!`);
            io.to(socket.id).emit('youAreKiller');
            
            setTimeout(() => startRoulette(room), 3000);
        } else {
            debugLog(room, 'Wrong accusation', {
                accuser: gameRoom.players.get(socket.id).name,
                accused: target
            });
            
            io.to(room).emit('systemMessage', `${gameRoom.players.get(socket.id).name} wrongly accused ${target}. The game continues...`);
            setTimeout(() => startRoulette(room), 3000);
        }
    });

    socket.on('elimination', ({room, target}) => {
        const gameRoom = gameRooms.get(room);
        if (!gameRoom || socket.id !== gameRoom.killer) return;

        const targetPlayerId = Array.from(gameRoom.players.entries())
            .find(([_, p]) => p.name === target)?.[0];

        if (targetPlayerId) {
            gameRoom.players.get(targetPlayerId).eliminated = true;
            gameRoom.eliminatedPlayers.add(targetPlayerId);

            io.to(room).emit('playerEliminated', {
                name: target,
                remaining: gameRoom.getAliveCount()
            });

            if (gameRoom.getAliveCount() <= 1) {
                io.to(room).emit('gameOver', gameRoom.players.get(gameRoom.killer).name);
                gameRooms.delete(room);
            } else {
                setTimeout(() => startRoulette(room), 3000);
            }
        }
    });

    socket.on('skipTurn', ({room}) => {
        const gameRoom = gameRooms.get(room);
        if (!gameRoom || socket.id !== gameRoom.killer) return;
        
        io.to(room).emit('systemMessage', 'Killer passed their turn');
        setTimeout(() => startRoulette(room), 1000);
    });

    socket.on('disconnect', () => {
        for (const [roomName, gameRoom] of gameRooms.entries()) {
            if (gameRoom.removePlayer(socket.id)) {
                if (gameRoom.killer === socket.id && gameRoom.players.size > 0) {
                    const newKiller = Array.from(gameRoom.players.keys())[0];
                    gameRoom.killer = newKiller;
                    io.to(newKiller).emit('youAreKiller');
                }
                updatePlayersInRoom(roomName);
                if (gameRoom.players.size === 0) {
                    gameRooms.delete(roomName);
                }
            }
        }
    });
});

function startRoulette(roomName) {
    const gameRoom = gameRooms.get(roomName);
    if (!gameRoom) return;

    debugLog(roomName, 'Starting roulette sequence');
    gameRoom.isRoulettePlaying = true;
    gameRoom.currentSelection = null;

    const activePlayers = Array.from(gameRoom.players.entries())
        .filter(([_, p]) => !p.eliminated);

    if (activePlayers.length < 2) {
        debugLog(roomName, 'Not enough players for roulette');
        return;
    }

    let rouletteSpeed = 100;  // Start very fast
    let rotations = 0;
    let currentIndex = 0;
    const targetRotations = Math.floor(Math.random() * 5) + 8; // 8-12 full rotations
    const speedIncreaseFactor = 1.2; // How much to slow down each rotation

    if (gameRoom.rouletteInterval) {
        clearInterval(gameRoom.rouletteInterval);
    }

    io.to(roomName).emit('rouletteStarting', { totalRotations: targetRotations });
    
    const runRoulette = () => {
        const currentPlayer = activePlayers[currentIndex];
        const playerName = gameRoom.players.get(currentPlayer[0]).name;
        
        io.to(roomName).emit('rouletteUpdate', {
            selectedName: playerName,
            currentRotation: rotations,
            totalRotations: targetRotations,
            speed: rouletteSpeed
        });

        currentIndex = (currentIndex + 1) % activePlayers.length;

        if (currentIndex === 0) {
            rotations++;
            debugLog(roomName, `Rotation ${rotations}/${targetRotations}, Speed: ${rouletteSpeed}ms`);

            if (rotations >= targetRotations) {
                clearInterval(gameRoom.rouletteInterval);
                gameRoom.isRoulettePlaying = false;

                const finalIndex = activePlayers.length - 1;
                const finalPlayer = activePlayers[finalIndex];
                gameRoom.currentSelection = finalPlayer[0];

                const isKiller = finalPlayer[0] === gameRoom.killer;
                debugLog(roomName, `Roulette final selection: ${finalPlayer[1].name} (Killer: ${isKiller})`);

                io.to(roomName).emit('rouletteStop', {
                    selectedId: finalPlayer[0],
                    selectedName: finalPlayer[1].name,
                    isKiller: isKiller
                });

                return;
            }

            rouletteSpeed = Math.min(1000, rouletteSpeed * speedIncreaseFactor);
            clearInterval(gameRoom.rouletteInterval);
            gameRoom.rouletteInterval = setInterval(runRoulette, rouletteSpeed);
        }
    };

    gameRoom.rouletteInterval = setInterval(runRoulette, rouletteSpeed);
}

function updatePlayersInRoom(roomName) {
    const gameRoom = gameRooms.get(roomName);
    if (!gameRoom) return;

    const playerData = Array.from(gameRoom.players.entries()).map(([id, player]) => ({
        id,
        name: player.name,
        eliminated: player.eliminated,
        selected: id === gameRoom.currentSelection
    }));

    io.to(roomName).emit('updatePlayers', { players: playerData });
}

http.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
