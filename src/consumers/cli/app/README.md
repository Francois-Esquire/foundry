# Product Manager CLI

This CLI application helps manage product documentation, including user journeys, systems, and development plans.

## Screens (Site Map)

- **Welcome Screen** (`WelcomeScreen.tsx`)
  - Initial entry point with banner.
- **Project List Screen** (`ProjectListScreen.tsx`)
  - Lists existing products.
  - Option to create a new product.
- **Create Project Screen** (`CreateProjectScreen.tsx`)
  - Form to create a new product.
- **Product Screen** (`ProductScreen.tsx`)
  - Shows details for a selected product.
  - Options to navigate to related screens:
    - **Tasks View** (`TasksView.tsx`)
      - Lists tasks for the selected product.
      - Option to create a new task.
      - Option to view/edit a task.
    - **Create Task Screen** (`CreateTaskScreen.tsx` - *To be created*)
      - Form to create a new task.
    - **Task Detail Screen** (`TaskDetailScreen.tsx` - *To be created*)
      - View/edit details of a specific task.
    - **User Journey View** (`UserJourneyView.tsx` - *To be created*)
      - Displays the user journey for the product.
      - Option to edit the journey.
    - **Systems View** (`SystemsView.tsx` - *To be created*)
      - Displays the system documentation for the product.
      - Option to edit the documentation.
    - **Plans View** (`PlansView.tsx` - *To be created*)
      - Displays development plans for the product.
      - Option to create/edit plans.

## To-Do List (Initial Path)

- [x] **Welcome Screen:** Display a welcome banner and prompt the user to continue.
  - File: `src/consumers/cli/app/screens/WelcomeScreen.tsx`
- [x] **Project List Screen:** Show existing projects or an option to create a new one.
  - File: `src/consumers/cli/app/screens/ProjectListScreen.tsx`
  - Components: `ProductSelector`, `CreateButton`, `PageHeader`
- [x] **Create Project Screen:** Provide a form to input the name and description for a new product.
  - File: `src/consumers/cli/app/screens/CreateProjectScreen.tsx`
  - Components: `PageHeader`
- [x] **Task View Screen:** Display tasks related to a selected product.
  - File: `src/consumers/cli/app/screens/TasksView.tsx`
  - Components: `ListTasks`, `CreateButton`, `PageHeader`, `TaskItem`
- [ ] **Product Screen:** Display detailed information about a selected product, including options to view/manage tasks, user journeys, etc.
  - File: `src/consumers/cli/app/screens/ProductScreen.tsx` (Needs implementation)
- [ ] **Task Creation Screen:** Implement a form to create new tasks for a product.
  - File: (Needs creation)
- [ ] **State Management:** Integrate selected product state into the main `App` component to navigate to the `ProductScreen` or `TasksView` correctly.
- [ ] **Persistence:** Implement saving and loading of products and tasks (e.g., to a local file or database).
