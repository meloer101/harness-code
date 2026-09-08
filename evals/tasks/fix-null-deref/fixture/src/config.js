/** Read the HTTP port out of a loaded config object. */
export function getPort(config) {
  return config.server.port;
}
