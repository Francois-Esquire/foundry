import { validateInitialConfig } from '../../helpers/errors';

import server from './server';

// Start the server if this file is being run directly
if (import.meta.main) {
  validateInitialConfig();

  server.start();
  console.log(`A2A Server started on port ${server.options.port}`);
}

export default server;
