# Foundry Command Reference

Here's a comprehensive reference of all available commands:

## Entry

```bash
# start in interactive mode
foundry start

# start with a specific prompt, using research and auto mode (which uses defaults for everything)
foundry start --prompt="<prompt>" --research --auto
```

## Configure

```bash
# Configure Foundry interactively
foundry configure

# Configure Foundry with a specific LLM model
foundry configure --model="<model>"

# Configure Foundry with a specific LLM model, role and temperature
foundry configure --model="<model>" --role="<role>" --temperature=<temperature>
```

## Generators

```bash
# Generate a new user journey
foundry generate user-journey --prompt="<prompt>"

# Generate a new brand guideline
foundry generate brand-guide --prompt="<prompt>"

# Generate a new style guideline (for code, design, etc.)
foundry generate style-guide --prompt="<prompt>"

# Generate a new PRD from user journey(s), brand guidelines, and style guidelines, etc (if they exist)
foundry generate prd
# will throw an error if no user journey exists

# Generate a new PRD from a user journey
foundry generate prd --prompt="<prompt>"
```

## Task Manager

### Parse PRD

```bash
# Parse a PRD file and generate tasks
foundry tasks parse-prd <prd-file.txt>

# Limit the number of tasks generated
foundry tasks parse-prd <prd-file.txt> --num-tasks=10
```

### List Tasks

```bash
# List all tasks
foundry tasks list

# List tasks with a specific status
foundry tasks list --status=<status>

# List tasks with subtasks
foundry tasks list --with-subtasks

# List tasks with a specific status and include subtasks
foundry tasks list --status=<status> --with-subtasks
```

### Show Next Task

```bash
# Show the next task to work on based on dependencies and status
foundry tasks next
```

### Show Specific Task

```bash
# Show details of a specific task
foundry tasks show <id>
# or
foundry tasks show --id=<id>

# View a specific subtask (e.g., subtask 2 of task 1)
foundry tasks show 1.2
```

### Update Tasks

```bash
# Update tasks from a specific ID and provide context
foundry tasks update --from=<id> --prompt="<prompt>"
```

### Update a Specific Task

```bash
# Update a single task by ID with new information
foundry tasks update-task --id=<id> --prompt="<prompt>"

# Use research-backed updates with Perplexity AI
foundry tasks update-task --id=<id> --prompt="<prompt>" --research
```

### Update a Subtask

```bash
# Append additional information to a specific subtask
foundry tasks update-subtask --id=<parentId.subtaskId> --prompt="<prompt>"

# Example: Add details about API rate limiting to subtask 2 of task 5
foundry tasks update-subtask --id=5.2 --prompt="Add rate limiting of 100 requests per minute"

# Use research-backed updates with Perplexity AI
foundry tasks update-subtask --id=<parentId.subtaskId> --prompt="<prompt>" --research
```

Unlike the `update-task` command which replaces task information, the `update-subtask` command _appends_ new information to the existing subtask details, marking it with a timestamp. This is useful for iteratively enhancing subtasks while preserving the original content.

### Generate Task Files

```bash
# Generate individual task files from tasks.json
foundry tasks generate
```

### Set Task Status

```bash
# Set status of a single task
foundry tasks set-status --id=<id> --status=<status>

# Set status for multiple tasks
foundry tasks set-status --id=1,2,3 --status=<status>

# Set status for subtasks
foundry tasks set-status --id=1.1,1.2 --status=<status>
```

When marking a task as "done", all of its subtasks will automatically be marked as "done" as well.

### Expand Tasks

```bash
# Expand a specific task with subtasks
foundry tasks expand --id=<id> --num=<number>

# Expand with additional context
foundry tasks expand --id=<id> --prompt="<context>"

# Expand all pending tasks
foundry tasks expand --all

# Force regeneration of subtasks for tasks that already have them
foundry tasks expand --all --force

# Research-backed subtask generation for a specific task
foundry tasks expand --id=<id> --research

# Research-backed generation for all tasks
foundry tasks expand --all --research
```

### Clear Subtasks

```bash
# Clear subtasks from a specific task
foundry tasks clear-subtasks --id=<id>

# Clear subtasks from multiple tasks
foundry tasks clear-subtasks --id=1,2,3

# Clear subtasks from all tasks
foundry tasks clear-subtasks --all
```

### Analyze Task Complexity

```bash
# Analyze complexity of all tasks
foundry tasks analyze-complexity

# Save report to a custom location
foundry tasks analyze-complexity --output=my-report.json

# Use a specific LLM model
foundry tasks analyze-complexity --model=claude-3-opus-20240229

# Set a custom complexity threshold (1-10)
foundry tasks analyze-complexity --threshold=6

# Use an alternative tasks file
foundry tasks analyze-complexity --file=custom-tasks.json

# Use Perplexity AI for research-backed complexity analysis
foundry tasks analyze-complexity --research
```

### View Complexity Report

```bash
# Display the task complexity analysis report
foundry tasks complexity-report

# View a report at a custom location
foundry tasks complexity-report --file=my-report.json --id=<id>
```

### Managing Task Dependencies

```bash
# Add a dependency to a task
foundry tasks add-dependency --id=<id> --depends-on=<id>

# Remove a dependency from a task
foundry tasks remove-dependency --id=<id> --depends-on=<id>

# Validate dependencies without fixing them
foundry tasks validate-dependencies

# Find and fix invalid dependencies automatically
foundry tasks fix-dependencies
```

### Add a New Task

```bash
# Add a new task using AI
foundry tasks add-task --prompt="Description of the new task"

# Add a task with dependencies
foundry tasks add-task --prompt="Description" --dependencies=1,2,3

# Add a task with priority
foundry tasks add-task --prompt="Description" --priority=high
```

### Initialize a Project

```bash
# Initialize a new project with Foundry Task Manager structure
foundry tasks init
```
