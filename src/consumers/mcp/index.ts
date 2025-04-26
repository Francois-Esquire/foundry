import server from './server';

import 'dotenv/config';

if (import.meta.main) {
  const { MCP_TRANSPORT_TYPE = 'stdio' } = process.env;

  let transportType = MCP_TRANSPORT_TYPE as 'stdio' | 'sse';
  let sse = undefined;

  if (transportType === 'sse') {
    transportType = 'sse';
    sse = {
      endpoint: '/sse' as const,
      port: 3000,
    };

    server.start({
      transportType,
      sse,
    });
  } else {
    transportType = 'stdio';
    server.start({
      transportType,
    });
  }
}

export default server;
