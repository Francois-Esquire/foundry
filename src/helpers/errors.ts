export class FoundryError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class FoundryConfigError extends FoundryError {
  constructor(message: string) {
    super(message);
  }
}

export class FoundryInputError extends FoundryError {
  constructor(message: string) {
    super(message);
  }
}

export class FoundryOutputError extends FoundryError {
  constructor(message: string) {
    super(message);
  }
}

export const validateInitialConfig = () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new FoundryConfigError('ANTHROPIC_API_KEY is not set');
  }
};
