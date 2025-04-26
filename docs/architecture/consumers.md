# Foundry Consumers Specification

This document outlines the architecture and implementation details for Foundry's consumer system.

## Overview

Consumers in Foundry are the interface points through which users and external applications interact with the system. They act as bridges between the outside world and Foundry's core functionality, providing consistent methods for invoking operations while abstracting away the internal implementation details.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  User/External  │◄───►│    Consumer     │◄───►│   Core Library  │
│  Application    │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
      Requests               Translation            Execution
```

## Core Consumer Interface

All consumers must implement the following core interface:

```typescript
interface Consumer {
  // Initialization & Configuration
  initialize(options: ConsumerOptions): Promise<void>;
  configure(options: Partial<ConsumerOptions>): Promise<void>;
  
  // Command Processing
  executeCommand(command: string, args: Record<string, any>): Promise<CommandResult>;
  
  // Status & Information
  getStatus(): Promise<ConsumerStatus>;
  getCapabilities(): Promise<ConsumerCapabilities>;
  
  // Lifecycle Management
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

### Consumer Options

```typescript
interface ConsumerOptions {
  // Core Configuration
  adapter?: Adapter;
  fallbackAdapter?: Adapter;
  agents?: Record<string, Agent>;
  
  // Authentication & Security
  authentication?: AuthOptions;
  
  // Logging & Monitoring
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  telemetry?: boolean;
  
  // Consumer-specific Options
  [key: string]: any;
}
```

### Command Result

```typescript
interface CommandResult {
  success: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  metadata: {
    executionTime: number;
    resourceUsage?: ResourceUsage;
  };
}
```

## Consumer Types

Foundry implements several specialized consumer types, each designed for specific use cases:

### Command Line Interface (CLI)

The CLI consumer provides a terminal-based interface for direct user interaction.

```typescript
interface CLIConsumer extends Consumer {
  // CLI-specific Methods
  parseArguments(args: string[]): Record<string, any>;
  renderOutput(result: CommandResult): void;
  
  // Interactive Mode
  startInteractiveMode(): Promise<void>;
  registerCompletions(): void;
}
```

#### Implementation Details

The CLI consumer uses a command parser to interpret user input and formats output for terminal display:

```typescript
class FoundryCLI implements CLIConsumer {
  constructor(options?: ConsumerOptions) {
    // Initialize with default options
  }
  
  async executeCommand(command: string, args: Record<string, any>): Promise<CommandResult> {
    // Process command using Core Library
    // Format result for CLI display
    return result;
  }
  
  async start(): Promise<void> {
    // Parse command-line arguments
    const args = this.parseArguments(process.argv.slice(2));
    
    if (args.interactive) {
      // Start interactive mode with REPL
      await this.startInteractiveMode();
    } else {
      // Execute single command
      const result = await this.executeCommand(args._[0], args);
      this.renderOutput(result);
      process.exit(result.success ? 0 : 1);
    }
  }
  
  // Other method implementations...
}
```

### Machine Control Protocol (MCP) Server

The MCP consumer provides a WebSocket-based interface for integration with IDEs and other development tools.

```typescript
interface MCPConsumer extends Consumer {
  // MCP-specific Methods
  handleConnection(connection: WebSocket): void;
  processMessage(message: MCPMessage): Promise<MCPResponse>;
  
  // Notification System
  sendNotification(connectionId: string, notification: MCPNotification): Promise<void>;
  broadcast(notification: MCPNotification): Promise<void>;
}
```

#### Implementation Details

The MCP consumer implements the Machine Control Protocol for integration with development tools:

```typescript
class FoundryMCP implements MCPConsumer {
  private server: WebSocketServer;
  private connections: Map<string, WebSocket> = new Map();
  
  constructor(options?: ConsumerOptions) {
    // Initialize with default options
  }
  
  async start(): Promise<void> {
    // Start WebSocket server
    this.server = new WebSocketServer({ port: this.options.port || 9000 });
    
    this.server.on('connection', (ws) => {
      // Handle new connections
      const connectionId = this.generateConnectionId();
      this.connections.set(connectionId, ws);
      this.handleConnection(ws);
    });
  }
  
  async processMessage(message: MCPMessage): Promise<MCPResponse> {
    // Convert MCP message to Foundry command
    const command = this.convertToCommand(message);
    
    // Execute command
    const result = await this.executeCommand(command.name, command.args);
    
    // Convert result to MCP response
    return this.convertToResponse(result);
  }
  
  // Other method implementations...
}
```

### REST API

The REST consumer provides an HTTP-based interface for web and distributed applications.

```typescript
interface RESTConsumer extends Consumer {
  // REST-specific Methods
  configureRoutes(app: Express): void;
  handleRequest(req: Request, res: Response): Promise<void>;
  
  // Authentication & Authorization
  authenticate(req: Request): Promise<AuthResult>;
  authorize(req: Request, command: string): Promise<boolean>;
}
```

#### Implementation Details

The REST consumer implements RESTful endpoints for HTTP-based integration:

```typescript
class FoundryREST implements RESTConsumer {
  private app: Express;
  
  constructor(options?: ConsumerOptions) {
    // Initialize with default options
  }
  
  async start(): Promise<void> {
    // Create Express app
    this.app = express();
    
    // Configure middleware
    this.app.use(express.json());
    this.app.use(cors(this.options.cors));
    
    // Configure authentication if enabled
    if (this.options.authentication) {
      this.app.use(this.authMiddleware.bind(this));
    }
    
    // Configure routes
    this.configureRoutes(this.app);
    
    // Start server
    this.server = this.app.listen(this.options.port || 3000);
  }
  
  configureRoutes(app: Express): void {
    // Define API endpoints
    app.post('/api/tasks', this.handleTasksRequest.bind(this));
    app.get('/api/tasks', this.handleTasksRequest.bind(this));
    app.get('/api/tasks/:id', this.handleTaskRequest.bind(this));
    // Additional routes...
  }
  
  // Other method implementations...
}
```

## Consumer Configuration

Consumers can be initialized with different configurations:

```typescript
// CLI Consumer
const cli = new FoundryCLI({
  adapter: new FileSystemAdapter({ basePath: process.cwd() }),
  fallbackAdapter: new InMemoryAdapter(),
  agents: {
    generator: new GeneratorAgent({ /* config */ }),
    researcher: new ResearchAgent({ /* config */ })
  },
  logLevel: 'info'
});

// MCP Consumer
const mcp = new FoundryMCP({
  adapter: new FileSystemAdapter({ basePath: workspaceRoot }),
  agents: { /* agent config */ },
  port: 9000,
  authentication: {
    type: 'token',
    validateToken: (token) => validateToken(token)
  }
});

// REST Consumer
const rest = new FoundryREST({
  adapter: new ConvexAdapter({ /* config */ }),
  agents: { /* agent config */ },
  port: 3000,
  authentication: {
    type: 'jwt',
    jwtSecret: process.env.JWT_SECRET
  },
  cors: {
    origin: ['https://myapp.com']
  }
});
```

## Consumer Usage

### CLI Usage

```bash
# Basic command execution
foundry tasks list --status=pending

# Interactive mode
foundry --interactive

# Custom adapter configuration
foundry --adapter=fs --adapter-path=/path/to/project tasks list
```

### MCP Usage

```typescript
// In an IDE extension
const socket = new WebSocket('ws://localhost:9000');

socket.onopen = () => {
  // Send command
  socket.send(JSON.stringify({
    id: '123',
    method: 'tasks.list',
    params: {
      status: 'pending'
    }
  }));
};

socket.onmessage = (event) => {
  const response = JSON.parse(event.data);
  // Process response
  console.log(response.result);
};
```

### REST Usage

```typescript
// In a web application
async function fetchTasks() {
  const response = await fetch('http://localhost:3000/api/tasks?status=pending', {
    headers: {
      'Authorization': 'Bearer ' + token
    }
  });
  
  const data = await response.json();
  return data;
}
```

## Future Enhancements

### Agent-to-Agent (a2a) Protocol Support

A future enhancement is to implement support for Google's Agent-to-Agent (a2a) protocol, which would allow Foundry to interact seamlessly with other AI agent systems.

```typescript
interface A2AConsumer extends Consumer {
  // a2a Protocol Methods
  handleA2ARequest(request: A2ARequest): Promise<A2AResponse>;
  createA2AAgent(config: A2AAgentConfig): Promise<string>;
  
  // Tool Registration
  registerTool(tool: A2ATool): Promise<void>;
}
```

The a2a protocol implementation would enable:

1. **Cross-agent communication**: Foundry agents could collaborate with agents from other systems
2. **Tool sharing**: Tools created by Foundry could be exposed to external agents
3. **Ecosystem integration**: Foundry could participate in broader AI agent ecosystems

### Additional Future Enhancements

1. **GraphQL API**: A GraphQL interface for more flexible data querying
2. **WebHooks**: Support for triggering external systems when events occur
3. **Event Streaming**: Real-time event streams for reactive applications
4. **Multi-tenant Support**: Ability to serve multiple isolated tenants from a single deployment
5. **SDK Generation**: Automatic generation of client SDKs for multiple languages 