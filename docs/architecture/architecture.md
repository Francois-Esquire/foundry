# Foundry Architecture

This document outlines the architecture of Foundry, which follows a modular design pattern to ensure flexibility, extensibility, and maintainability.

## Overview

Foundry is built on four main architectural components:

1. **Adapters** - Interface with external systems and resources
2. **Agents** - Generative AI components for various functions
3. **Consumers** - Interface points for users and applications
4. **Core Library** - Central generation and business logic

```
┌─────────────────────────────────────────────────────────┐
│                     CONSUMERS                           │
│                                                         │
│    ┌──────────────┐    ┌──────────┐    ┌──────────┐    │
│    │  Command Line │    │   MCP    │    │   REST   │    │
│    └──────────────┘    └──────────┘    └──────────┘    │
└───────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    CORE LIBRARY                          │
│                                                         │
│    ┌──────────────────────────────────────────────┐    │
│    │             Generation & Business Logic      │    │
│    └──────────────────────────────────────────────┘    │
│                                                         │
└────────────┬────────────────────────────┬───────────────┘
             │                            │
┌────────────▼────────────┐  ┌────────────▼────────────┐
│        ADAPTERS         │  │         AGENTS          │
│                         │  │                         │
│  ┌─────────────────┐    │  │  ┌─────────────────┐    │
│  │   File System   │    │  │  │    Generator    │    │
│  └─────────────────┘    │  │  └─────────────────┘    │
│                         │  │                         │
│  ┌─────────────────┐    │  │  ┌─────────────────┐    │
│  │    In-Memory    │    │  │  │    Researcher   │    │
│  └─────────────────┘    │  │  └─────────────────┘    │
│                         │  │                         │
│  ┌─────────────────┐    │  │  ┌─────────────────┐    │
│  │   GitHub API    │    │  │  │  Tool Manager   │    │
│  └─────────────────┘    │  │  └─────────────────┘    │
│                         │  │                         │
│  ┌─────────────────┐    │  │                         │
│  │ Convex Backend  │    │  │                         │
│  └─────────────────┘    │  │                         │
│                         │  │                         │
└─────────────────────────┘  └─────────────────────────┘
```

## Components in Detail

### Adapters

Adapters provide a consistent interface for input and output operations across different platforms and systems. They abstract away the specifics of each target system and are responsible for interacting with the environment to create, read, update, and delete resources.

#### Current Adapters:

- **File System Adapter**: Interacts with the local file system for reading and writing data (e.g., creating individual markdown files for tasks with embedded subtasks)
- **In-Memory Adapter**: Manages data in memory for testing and rapid operations

#### Planned Adapters:

- **GitHub API Adapter**: Will interface with GitHub for repository management
- **Convex Backend Adapter**: Will integrate with Convex for database storage and operations

#### Adapter Configuration and Fallbacks:

Adapters are typically configured when setting up a Consumer. Each Consumer type has specific behavior:

- **Command Line Interface**: Defaults to File System adapter if available, with automatic fallback to In-Memory adapter if needed
- **MCP Server**: Configurable with specified adapter, with fallback chain options
- **REST API**: Fully configurable adapter settings based on deployment needs

#### Transform Interface:

All adapters implement a transform interface that allows for operation interception. This provides:

- **Custom Transformers**: Ability to intercept and modify operations at any stage
- **Extension Points**: For building custom adapters with specialized behavior
- **Operation Hooking**: Pre and post-operation hooks for advanced use cases

This transform interface is part of the internal API and can be surfaced when implementing custom adapters.

### Agents

Agents are the generative AI components of the system. They use underlying AI models to perform specific tasks like content generation and research.

#### Agent Types:

- **Generator Agent**: Creates content based on specifications and requirements (including tasks, user journeys, PRDs)
- **Research Agent**: Gathers and synthesizes information from various sources
- **Tool Manager Agent**: Designs and implements tools that can extend Foundry's functionality on request

#### Agent Configuration:

Agents follow standard LLM (Large Language Model) usage patterns in the industry, with additional configuration options:

- **Model Selection**: Configure which LLM to use for different agent types
- **Context Window**: Define the size of the context window for processing
- **Temperature and Parameters**: Control generation parameters
- **API Keys and Endpoints**: Configure connections to LLM providers

### Consumers

Consumers are the interface points that applications and users interact with to access Foundry's functionality.

#### Consumer Types:

- **Command Line Interface**: Terminal-based interaction for direct user control
- **MCP Server**: Machine Control Protocol server for integration with IDEs and other systems
- **REST API**: HTTP-based interface for web and distributed applications

### Core Library

The Core Library is the central component that provides the business logic and generative capabilities of the system. It's not limited to task management but encompasses the full product development workflow.

#### Key Capabilities:

1. **Generative Workflows**: Creates user journeys, PRDs, and tasks based on high-level inputs
2. **Business Logic**: Implements rules and processes for the system
3. **Data Flow Management**: Ensures proper flow of data between components
4. **Execution Preparation**: Prepares tasks and workflows for execution

#### Full Product Workflow:

The Core Library enables a complete product development workflow:

1. **Initialization**: Foundry system initializes
2. **User Input**: System receives high-level product concept from user
3. **User Journey Creation**: Generates user journeys and experiences
4. **PRD Generation**: Creates detailed Product Requirements Document
5. **Task Generation**: Breaks down PRD into actionable tasks

## Interaction Flow

1. A Consumer receives a command from a user or application
2. The command is passed to the Core Library
3. The Core Library uses appropriate Agents to generate content or perform actions
4. Adapters interact with the environment to create, retrieve, update, or delete resources
5. Results are returned through the Core Library to the Consumer
6. The Consumer presents the results to the user or application

## Extension Points

Foundry's modular architecture allows for extension in several ways:

1. **New Adapters**: Adding support for additional storage systems or APIs
2. **New Agents**: Creating specialized AI-powered functionality
3. **New Consumers**: Developing alternative interfaces for different use cases
4. **Core Extensions**: Enhancing the Core Library with additional capabilities
5. **Tools**: The Tool Manager agent can create new tools that extend the library directly

## Future Considerations

1. **Plugin System**: A formal plugin architecture to allow third-party extensions
2. **Agent Composition**: Ability to chain multiple agents together for complex workflows
3. **Distributed Processing**: Supporting distributed execution across multiple machines
4. **Real-time Collaboration**: Enabling multiple users to work together on the same tasks
5. **End-to-End Product Development**: Supporting the entire product lifecycle from concept to deployment
6. **Advanced Memory and Indexing**: Specialized memory types for different content:
   - Code Base Indexing for navigating and understanding code repositories
   - Structured Data Memory for Figma files, databases, and other structured formats
   - Document Memory for books, articles, and unstructured content
   - Graph-Based Memory for representing complex relationships
7. **Agent Lifecycle Management**: Implementing a review process with defined steps and feedback loops
