/**
 * @file Holds a reference to the HTTP server so routes can close it during controlled shutdown (for example after a self-update).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

let server = null;

function setServer(s) {
  server = s;
}

function getServer() {
  return server;
}

function closeServer(callback) {
  if (!server) {
    if (callback) process.nextTick(callback);
    return;
  }
  server.close(callback);
}

module.exports = { setServer, getServer, closeServer };
