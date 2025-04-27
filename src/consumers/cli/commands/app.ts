import { helpers, termost } from "termost";

// Define our context type to hold state and options
type ProductContext = {
  // Command options
  prompt: string;
  description: string;
  name: string;
  id: string;
  format: string;

  // Product data
  products: Product[];
  currentProduct?: Product;
};

// Product model
interface Product {
  id: string;
  name: string;
  description: string;
  userJourney?: string[];
  systems?: string[];
  plans?: ProductPlan[];
  createdAt: Date;
  updatedAt: Date;
}

interface ProductPlan {
  id: string;
  title: string;
  description: string;
  steps: string[];
  createdAt: Date;
}

/**
 * Initialize the CLI app with termost
 */
export function createProductManagerApp() {
  // Initialize program with context
  const program = termost<ProductContext>({
    name: "product-manager",
    description: "A CLI tool for managing product documentation and plans",
    version: "1.0.0",
    onException(error) {
      console.error(`Error: ${error.message}`);
    },
    onShutdown() {
      console.log("Product Manager CLI has been shut down.");
    },
  });

  // Add commands first
  addCommands(program);

  // This will be handled by any actual usage of the application
  // The context will be initialized when first accessed

  program;

  return program;
}

/**
 * Add all commands to the program
 */
function addCommands(program: ReturnType<typeof termost<ProductContext>>) {
  // Create a new product
  program
    .command({
      name: "create",
      description: "Create a new product",
    })
    .option({
      key: "prompt",
      name: "prompt",
      description: "Product concept prompt",
    })
    .option({
      key: "name",
      name: "name",
      description: "Product name",
    })
    .task({
      async handler(context) {
        const { prompt, name } = context;

        if (!prompt) {
          helpers.message("Error: Product prompt is required", {
            type: "error",
          });
          return;
        }

        helpers.message("Creating a new product...", { type: "information" });

        // Initialize products array if needed
        if (!context.products) {
          context.products = [];
        }

        // Generate a unique ID
        const id = generateUniqueId();
        const productName = name || `Product-${id.substring(0, 8)}`;

        // Create new product
        const product: Product = {
          id,
          name: productName,
          description: prompt,
          userJourney: [],
          systems: [],
          plans: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        // Add to context
        context.products.push(product);
        context.currentProduct = product;

        helpers.message(`Product "${productName}" created successfully!`, {
          type: "success",
        });

        // Generate initial documentation based on prompt
        await generateProductDocumentation(context);
      },
    });

  // List all products
  program
    .command({
      name: "list",
      description: "List all products",
    })
    .option({
      key: "format",
      name: "format",
      description: "Output format (json, table)",
      defaultValue: "table",
    })
    .task({
      handler(context) {
        const { format } = context;

        // Initialize products array if needed
        if (!context.products) {
          context.products = [];
        }

        if (context.products.length === 0) {
          helpers.message("No products found.", { type: "warning" });
          return;
        }

        helpers.message(`Found ${context.products.length} products:`, {
          type: "information",
        });

        if (format === "json") {
          console.log(JSON.stringify(context.products, null, 2));
        } else {
          // Display as table
          const table = context.products.map((product) => ({
            ID: product.id.substring(0, 8),
            Name: product.name,
            Description:
              product.description.substring(0, 50) +
              (product.description.length > 50 ? "..." : ""),
            Created: product.createdAt.toLocaleDateString(),
          }));

          console.table(table);
        }
      },
    });

  // Select a product to work with
  program
    .command({
      name: "select",
      description: "Select a product to work with",
    })
    .option({
      key: "id",
      name: "id",
      description: "Product ID",
    })
    .task({
      handler(context) {
        const { id } = context;

        // Initialize products array if needed
        if (!context.products) {
          context.products = [];
        }

        if (!id) {
          helpers.message("Error: Product ID is required", { type: "error" });
          return;
        }

        const product = context.products.find(
          (p) => p.id === id || p.id.startsWith(id),
        );

        if (!product) {
          helpers.message(`Product with ID "${id}" not found.`, {
            type: "error",
          });
          return;
        }

        context.currentProduct = product;
        helpers.message(`Selected product: ${product.name}`, {
          type: "success",
        });
      },
    });

  // Generate user journey
  program
    .command({
      name: "generate-journey",
      description: "Generate user journey documentation",
    })
    .option({
      key: "prompt",
      name: "prompt",
      description: "Additional context for the user journey",
    })
    .task({
      async handler(context) {
        const { currentProduct } = context;
        // We would use context.prompt in a real implementation

        if (!currentProduct) {
          helpers.message(
            'No product selected. Use the "select" command first.',
            { type: "error" },
          );
          return;
        }

        helpers.message(
          `Generating user journey for "${currentProduct.name}"...`,
          { type: "information" },
        );

        // Here we would integrate with an AI to generate the journey
        const journey = [
          "User discovers the product through marketing",
          "User signs up for a free trial",
          "User explores key features",
          "User converts to paid plan",
          "User becomes a power user and advocate",
        ];

        currentProduct.userJourney = journey;
        currentProduct.updatedAt = new Date();

        helpers.message("User journey generated successfully!", {
          type: "success",
        });
        journey.forEach((step, index) => {
          console.log(`${index + 1}. ${step}`);
        });
      },
    });

  // Generate systems documentation
  program
    .command({
      name: "generate-systems",
      description: "Generate systems documentation",
    })
    .option({
      key: "prompt",
      name: "prompt",
      description: "Additional context for the systems documentation",
    })
    .task({
      async handler(context) {
        const { currentProduct } = context;
        // We would use context.prompt in a real implementation

        if (!currentProduct) {
          helpers.message(
            'No product selected. Use the "select" command first.',
            { type: "error" },
          );
          return;
        }

        helpers.message(
          `Generating systems documentation for "${currentProduct.name}"...`,
          { type: "information" },
        );

        // Here we would integrate with an AI to generate the systems docs
        const systems = [
          "Authentication system: Handles user login and session management",
          "Payment system: Processes subscriptions and payments",
          "Content management system: Manages product content and assets",
          "Analytics system: Tracks user behavior and product usage",
          "Notification system: Sends alerts and communications to users",
        ];

        currentProduct.systems = systems;
        currentProduct.updatedAt = new Date();

        helpers.message("Systems documentation generated successfully!", {
          type: "success",
        });
        systems.forEach((system, index) => {
          console.log(`${index + 1}. ${system}`);
        });
      },
    });

  // Generate product plan
  program
    .command({
      name: "generate-plan",
      description: "Generate a product development plan",
    })
    .option({
      key: "prompt",
      name: "prompt",
      description: "Additional context for the product plan",
    })
    .option({
      key: "name",
      name: "name",
      description: "Plan name",
      defaultValue: "Development Plan",
    })
    .task({
      async handler(context) {
        const { name, currentProduct } = context;
        // We would use context.prompt in a real implementation

        if (!currentProduct) {
          helpers.message(
            'No product selected. Use the "select" command first.',
            { type: "error" },
          );
          return;
        }

        helpers.message(
          `Generating product plan for "${currentProduct.name}"...`,
          { type: "information" },
        );

        // Here we would integrate with an AI to generate the plan
        const plan: ProductPlan = {
          id: generateUniqueId(),
          title: name,
          description: `Development plan for ${currentProduct.name}`,
          steps: [
            "Phase 1: Research and validation",
            "Phase 2: MVP development",
            "Phase 3: Beta testing",
            "Phase 4: Public launch",
            "Phase 5: Iteration and improvement",
          ],
          createdAt: new Date(),
        };

        if (!currentProduct.plans) {
          currentProduct.plans = [];
        }

        currentProduct.plans.push(plan);
        currentProduct.updatedAt = new Date();

        helpers.message("Product plan generated successfully!", {
          type: "success",
        });
        console.log(`Plan: ${plan.title}`);
        console.log(`Description: ${plan.description}`);
        console.log("Steps:");
        plan.steps.forEach((step, index) => {
          console.log(`${index + 1}. ${step}`);
        });
      },
    });

  program
    .command({
      name: "start",
      description: "Interactive product manager",
    })
    .input({
      type: "select",
      key: "input1",
      label: "What is your single choice?",
      options: ["singleOption1", "singleOption2"],
      defaultValue: "singleOption2",
    })
    .input({
      type: "multiselect",
      key: "input2",
      label: "What is your multiple choices?",
      options: ["multipleOption1", "multipleOption2"],
      defaultValue: ["multipleOption2"],
    })
    .input({
      type: "confirm",
      key: "input3",
      label: "Are you sure to skip next input?",
      defaultValue: false,
    })
    .task({
      handler(context) {
        const { currentProduct } = context;

        if (!currentProduct) {
          helpers.message(
            'No product selected. Use the "select" command first.',
            { type: "error" },
          );
        } else {
          helpers.message(
            `Starting interactive product manager for "${currentProduct.name}"...`,
            { type: "information" },
          );
        }

        // Here we would integrate with an AI to start the interactive manager
        // For now, we'll just create a simple loop

        let running = true;

        while (running) {
          const { input1, input2, input3 } = context;

          console.log(input1, input2, input3);

          setTimeout(() => {
            running = false;
          }, 5000);
        }
      },
    });

  return program;
}

/**
 * Generate a unique ID
 */
function generateUniqueId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

/**
 * Generate initial product documentation based on the prompt
 */
async function generateProductDocumentation(context: ProductContext) {
  const { currentProduct } = context;

  if (!currentProduct) {
    return;
  }

  helpers.message("Generating initial product documentation...", {
    type: "information",
  });

  // In a real implementation, this would call an AI service to generate documentation
  // For now, we'll just create placeholder content

  // Generate user journey
  currentProduct.userJourney = [
    "User discovers the product",
    "User signs up for an account",
    "User explores core features",
    "User integrates product into workflow",
    "User becomes regular user",
  ];

  // Generate systems documentation
  currentProduct.systems = [
    "Frontend system: User interface and experience",
    "Backend system: API and data processing",
    "Database system: Data storage and retrieval",
    "Authentication system: User management",
  ];

  // Generate initial plan
  const initialPlan: ProductPlan = {
    id: generateUniqueId(),
    title: "Initial Development Plan",
    description: `First development plan for ${currentProduct.name}`,
    steps: [
      "Validate product idea with market research",
      "Create product specifications",
      "Develop MVP (Minimum Viable Product)",
      "Test with early adopters",
      "Iterate based on feedback",
      "Prepare for public launch",
    ],
    createdAt: new Date(),
  };

  if (!currentProduct.plans) {
    currentProduct.plans = [];
  }

  currentProduct.plans.push(initialPlan);

  helpers.message("Initial documentation generated successfully!", {
    type: "success",
  });
}

if (import.meta.main) {
  createProductManagerApp();
}
