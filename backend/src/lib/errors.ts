/** An error that carries a status code and, optionally, user-facing next steps. */
export class AppError extends Error {
  readonly status: number
  readonly recoveryCommands?: string[]

  constructor(message: string, status = 500, recoveryCommands?: string[]) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.recoveryCommands = recoveryCommands
  }
}

export const notFound = (what: string) => new AppError(`${what} not found`, 404)
export const badRequest = (message: string) => new AppError(message, 400)
export const conflict = (message: string) => new AppError(message, 409)
