import { createPrivateTerminalServer, loadPrivateTerminalServerConfig } from "./http-server.js";

const config = loadPrivateTerminalServerConfig();
const server = createPrivateTerminalServer(config);

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `Private terminal service listening on http://${config.host}:${config.port}\n`,
  );
});
