# Foundry Philosophy: From Vision to Execution

This document outlines the philosophical approach and methodology that Foundry uses to transform abstract ideas into concrete, actionable tasks.

## Overview

Foundry embraces a user-centered, emotionally aware approach to product development. Rather than starting with technical specifications or feature lists, we begin with user journeys and emotional maps that capture the human experience. This foundation allows us to build products that not only function well but resonate with users on a deeper level.

```
┌────────────────┐      ┌───────────────┐      ┌────────────────┐      ┌──────────────┐      ┌─────────────┐
│                │      │               │      │                │      │              │      │             │
│  User Vision   │──────►  User Journey │──────►  Emotional Map │──────►   Site Map   │──────►    Tasks    │
│                │      │               │      │                │      │              │      │             │
└────────────────┘      └───────────────┘      └────────────────┘      └──────────────┘      └─────────────┘
```

## From Vision to Tasks: The Foundry Workflow

### 1. User Vision

Every great product begins with a vision - a clear articulation of the problem to be solved and the impact the solution will have. The vision statement captures:

- The core problem or opportunity
- The target audience
- The transformative impact
- The unique approach or perspective

**Example Vision Statement:**

> "Create a collaborative workspace that transforms how remote teams share knowledge by making information discovery as natural and effortless as face-to-face conversation."

Foundry uses generative AI to help refine and expand this vision, ensuring it's compelling, clear, and actionable.

### 2. User Journeys

User journeys map the path that different users take when interacting with a product. These narratives:

- Focus on specific user personas with distinct needs
- Trace the complete experience from initial awareness to long-term usage
- Identify key touchpoints, goals, and potential pain points
- Highlight emotional and functional aspects of the experience

**Example User Journey Structure:**

```
Persona: Sarah, Product Manager at a Mid-Size Tech Company

Stage 1: Discovery
- Current Situation: Struggling with information silos across her distributed team
- Trigger: Colleague mentions Foundry at a conference
- Action: Visits website to learn more
- Thoughts/Feelings: Curious but skeptical; has tried other tools before
- Touchpoints: Website, product demo video

Stage 2: Consideration
...

Stage 3: Onboarding
...

Stage 4: Regular Usage
...

Stage 5: Advocacy
...
```

Foundry generates comprehensive user journeys for various personas, identifying critical moments and expectations throughout the product lifecycle.

### 3. Emotional Maps

Emotional maps extend user journeys by explicitly mapping the emotional states users experience throughout their journey. This emotional awareness helps create more engaging, satisfying products by:

- Identifying emotional highs and lows in the user experience
- Recognizing emotional triggers and transition points
- Designing features that address emotional needs, not just functional ones
- Creating opportunities for delight and connection

**Example Emotional Map Elements:**

```
Touchpoint: First-time login
Expected Emotion: Anticipation mixed with uncertainty
Desired Emotion: Confidence and excitement
Gap Analysis: Need to reduce friction and provide immediate value
Design Implications: Streamlined onboarding with quick wins
```

Foundry creates detailed emotional maps alongside user journeys, ensuring that the emotional dimension of product experience receives proper attention.

### 4. Site Maps and Information Architecture

Based on user journeys and emotional maps, Foundry generates site maps and information architecture that organize the product's content and functionality in user-centered ways:

- Primary navigation paths aligned with key user journeys
- Information hierarchy reflecting user priorities and mental models
- Functional groupings that feel intuitive to target users
- Content organization that supports emotional goals

**Example Site Map Elements:**

```
1. Home/Dashboard
   1.1 Activity Feed
   1.2 Quick Actions
   1.3 Recent Items

2. Knowledge Base
   2.1 Document Library
      2.1.1 Folders
      2.1.2 Tags
      2.1.3 Search
   2.2 Team Wikis
   2.3 Media Gallery

3. Collaboration
...
```

The site map serves as a bridge between the conceptual user journeys and the concrete implementation details.

### 5. Task Generation and Organization

Finally, Foundry breaks down the site map and information architecture into specific implementation tasks. Each task is:

- Self-contained but connected to the broader context
- Tied directly to user journey elements
- Prioritized based on user needs and technical dependencies
- Tagged with relevant emotional goals

**Example Task Structure:**

```
Task ID: 12
Title: Implement Document Sharing Modal
Description: Create a modal dialog for sharing documents with team members
User Journey Connection: Supports "Collaboration" phase of the PM persona journey
Emotional Goal: Reduce anxiety around permissions by making sharing intuitive
Acceptance Criteria:
- Users can search for team members to share with
- Permission levels are clearly explained
- Preview shows exactly what will be shared
- Confirmation feedback is provided
Dependencies: Task 8 (User Permission System)
```

Tasks are organized into a dependency graph that respects both technical requirements and user priorities, creating a development roadmap that balances technical efficiency with user value.

## Advantages of the Foundry Approach

This philosophy provides several key advantages:

1. **User-Centered From Inception**: Every development decision can be traced back to user needs
2. **Emotional Intelligence**: Products address both functional and emotional user needs
3. **Coherent Vision**: All team members understand the "why" behind specific features
4. **Adaptable Prioritization**: Task priorities can adapt to emerging user insights
5. **Technical Realism**: Tasks are broken down with technical constraints in mind
6. **Continuous Alignment**: Decisions can always be validated against user journeys

## Implementation in Practice

Foundry's implementation of this philosophy is automated through its generative components:

### Generator Agent Workflow

```
1. Vision Input → Vision Refinement
2. Vision → Persona Generation
3. Personas → User Journey Creation
4. User Journeys → Emotional Mapping
5. Journeys + Emotional Maps → Site Map Generation
6. Site Map → Task Breakdown
7. Tasks → PRD Generation
```

### Example Prompts Used in the Process

**User Journey Generation Prompt:**

```
Based on the vision statement "{vision}" and persona "{persona}",
create a comprehensive user journey that follows this user through
their entire experience with the product. For each stage, include:

1. The user's situation and context
2. Their immediate goals and needs
3. Actions they take
4. Thoughts and feelings they experience
5. Touchpoints with the product
6. Opportunities and pain points

Structure the journey into these stages: Discovery, Consideration,
Onboarding, Regular Usage, and Advocacy.
```

**Emotional Map Prompt:**

```
For the following user journey touchpoints, create an emotional
map that captures:

1. The expected emotional state of the user
2. The desired emotional state we want to create
3. The gap between these states
4. Design implications to bridge this gap

User Journey: {user_journey_json}
```

## Conclusion

Foundry's philosophical approach represents a comprehensive methodology for product development that bridges human-centered design and technical implementation. By starting with user journeys and emotional maps before moving to site maps and tasks, Foundry ensures that technical execution remains firmly connected to user needs and experiences.

This approach produces products that are not only functional but emotionally resonant, creating deeper connections with users and delivering more meaningful value.
