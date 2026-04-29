export class DisallowedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisallowedConfigError";
  }
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
