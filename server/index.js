const http = require('http');
const io = require('socket.io')();
const socketAuth = require('socketio-auth');
const adapter = require('socket.io-redis');

const redis = require('./redis');

const PORT = process.env.PORT || 9000;
const server = http.createServer();

const redisAdapter = adapter({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASS || 'password',
});

io.attach(server);
io.adapter(redisAdapter);
 
// dummy user verification
async function verifyUser (token) {
  return new Promise((resolve, reject) => {
    // setTimeout to mock a cache or database call
    setTimeout(() => {
      // this information should come from your cache or database
      const users = [
        {
          id: 1,
          name: 'mariotacke',
          token: 'secret token',
        },
      ];

      const user = users.find((user) => user.token === token);

      if (!user) {
        return reject('USER_NOT_FOUND');
      }

      return resolve(user);
    }, 200);
  });
}

socketAuth(io, {
  authenticate: async (socket, data, callback) => {
    const { token } = data;

    try {
      const user = await verifyUser(token);

      // NX will make sure that we only set the key if it does not already exist. If it does, the command returns null
      // EX 30 to the command to auto-expire the lock after 30 seconds. 
      // The reason I chose 30 seconds is because Socket.IO has a default ping of 25 seconds,
      // that is, every 25 seconds it will probe connected users to see if they are still connected. 

      const canConnect = await redis
        .setAsync(`users:${user.id}`, socket.id, 'NX', 'EX', 30);

      if (!canConnect) {
        return callback({ message: 'ALREADY_LOGGED_IN' });
      }

      socket.user = user;

      return callback(null, true);
    } catch (e) {
      console.log(`Socket ${socket.id} unauthorized.`);
      return callback({ message: 'UNAUTHORIZED' });
    }
  },
  postAuthenticate: async (socket) => {
    console.log(`Socket ${socket.id} authenticated.`);

    socket.conn.on('packet', async (packet) => {

      // postAuthenticate event to register our packet event handler. 
      // Our handler then checks if the socket is authenticated via socket.auth and if the packet is of type ping

      if (socket.auth && packet.type === 'ping') {
        await redis.setAsync(`users:${socket.user.id}`, socket.id, 'XX', 'EX', 30); // XX states that it will only be set if it already exists. 
      }
    });
  },
  disconnect: async (socket) => {
    console.log(`Socket ${socket.id} disconnected.`);

    if (socket.user) {
      await redis.delAsync(`users:${socket.user.id}`);
    }
  },
})

server.listen(PORT);
