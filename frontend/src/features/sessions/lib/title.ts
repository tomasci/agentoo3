// The backend's bound on a title (`PATCH /sessions/{id}` takes 1 to 200
// characters). Shared by both rename inputs — the dialog and the session
// page's inline title — so each stops accepting text where the server would
// start refusing it.
export const MAX_TITLE_LENGTH = 200
