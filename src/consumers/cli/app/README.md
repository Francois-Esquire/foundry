# Product Manager CLI

This CLI application helps manage product documentation, including user journeys, systems, and development plans.

## Screens (Site Map)

- **Welcome Screen** (`WelcomeScreen.tsx`)
  - Initial entry point with banner.
- **Dashboard Screen** (`DashboardScreen.tsx`)
  - Overview of products, tasks, and quick actions.
- **Product List Screen** (`ProductListScreen.tsx`)
  - Lists existing products.
  - Option to create a new product.
- **Create Product Screen** (`CreateProductScreen.tsx`)
  - Form to create a new product.
- **Product Screen** (`ProductScreen.tsx`)
  - Shows details for a selected product.
  - Lists tasks for the selected product.
  - Option to create a task for the product.
  - *Future Enhancements: Tabs/Sections for User Journeys, Systems Docs, Coding Styles*
- **Task List Screen** (`TaskListScreen.tsx`)
  - Lists all tasks (or filtered tasks).
  - Option to create a new task.
- **Create Task Screen** (`CreateTaskScreen.tsx`)
  - Form to create a new task (can be linked to a product).
- **Task Screen** (`TaskScreen.tsx`)
  - View details of a specific task, including subtasks and product link.
- **Analyze Project Screen** (`AnalyzeProjectScreen.tsx`)
  - Screen to trigger project analysis using scanning and LLM.
- **Configure Screen** (`ConfigureScreen.tsx`)
  - Allows setting configuration options (e.g., base path).
- **User Journey Screen** (`UserJourneyScreen.tsx` - *To be created*)
  - Displays/Edits the user journey for a product.
- **Chat Screen** (`ChatScreen.tsx` - *To be created*)
  - Interface for interacting with an LLM.
- **Dependency Graph Screen** (`DependencyGraphScreen.tsx` - *To be created*)
  - Visualizes task and subtask dependencies.
- **Not Found Screen** (`NotFound.tsx`)
  - Displayed for invalid routes.

## To-Do List

- [x] **Welcome Screen:** Display banner and prompt.
- [x] **Dashboard Screen:** Overview with stats, recent items, quick actions.
- [x] **Product List Screen:** Show existing products, option to create.
- [x] **Create Product Screen:** Form for new product.
- [x] **Product Screen:** Display product details and associated tasks.
- [x] **Task List Screen:** Show tasks, option to create.
- [x] **Create Task Screen:** Form for new task.
- [x] **Task Screen:** Display task details.
- [x] **Analyze Project Screen:** Placeholder flow for analysis.
- [x] **Configure Screen:** Basic configuration options.
- [x] **Not Found Screen:** Basic 404 page.
- [ ] **User Journey Screen:** Implement view/edit for user journeys.
- [ ] **Chat Screen:** Implement LLM chat interface.
- [ ] **Dependency Graph Screen:** Implement task dependency visualization.
- [ ] **Enhance Product Screen:** Add sections/tabs for User Journeys, Systems Docs, Coding Styles.
- [ ] **Implement Analyze Project:** Connect placeholder functions to actual file scanning and LLM calls.
- [ ] **Implement Dashboard Actions:** Connect "Analyze Project" and "Get Next Task" buttons.
- [ ] **State Management:** Refine state selectors and potentially add persistence.
- [ ] **Navigation/Focus:** Improve navigation and focus management across all screens.
- [ ] **Editing/Deleting:** Add edit and delete functionality for products and tasks.


*Self-Correction: Renamed some views to Screens for consistency. Updated completed status.*
