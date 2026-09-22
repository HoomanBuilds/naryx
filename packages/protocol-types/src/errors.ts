export type ProtocolErrorCode =
  | 'RANGE'
  | 'MALFORMED'
  | 'DUPLICATE'
  | 'INCOMPATIBLE_UNIT'
  | 'DIVISION_BY_ZERO';

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly context: string;
  readonly detail: string;

  constructor(code: ProtocolErrorCode, context: string, detail: string) {
    super(`${code} ${context}: ${detail}`);
    this.name = 'ProtocolError';
    this.code = code;
    this.context = context;
    this.detail = detail;
  }
}

export class RangeViolationError extends ProtocolError {
  constructor(context: string, detail: string) {
    super('RANGE', context, detail);
    this.name = 'RangeViolationError';
  }
}

export class MalformedInputError extends ProtocolError {
  constructor(context: string, detail: string) {
    super('MALFORMED', context, detail);
    this.name = 'MalformedInputError';
  }
}

export class DuplicateElementError extends ProtocolError {
  constructor(context: string, detail: string) {
    super('DUPLICATE', context, detail);
    this.name = 'DuplicateElementError';
  }
}

export class IncompatibleUnitError extends ProtocolError {
  constructor(context: string, detail: string) {
    super('INCOMPATIBLE_UNIT', context, detail);
    this.name = 'IncompatibleUnitError';
  }
}

export class DivisionByZeroError extends ProtocolError {
  constructor(context: string, detail: string) {
    super('DIVISION_BY_ZERO', context, detail);
    this.name = 'DivisionByZeroError';
  }
}
