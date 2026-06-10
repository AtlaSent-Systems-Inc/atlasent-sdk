package io.atlasent.sdk;

/**
 * Exception thrown by {@link AtlaSentClient} for non-2xx HTTP responses and
 * other unrecoverable errors (network failures, JSON parse errors, etc.).
 *
 * <p>AtlaSent is fail-closed: a clean policy DENY is returned as a normal
 * {@link model.EvaluateResponse} (decision = "deny"), never thrown as an
 * exception. This exception surfaces only when the API itself cannot be
 * reached or returns an unexpected error status.</p>
 */
public class AtlaSentException extends RuntimeException {

    private final int statusCode;

    /**
     * Constructs a new AtlaSentException.
     *
     * @param statusCode HTTP status code (0 if not applicable, e.g. network error)
     * @param message    Human-readable description including the response body when available
     */
    public AtlaSentException(int statusCode, String message) {
        super(message);
        this.statusCode = statusCode;
    }

    /**
     * Constructs a new AtlaSentException wrapping a root cause.
     *
     * @param statusCode HTTP status code (0 if not applicable)
     * @param message    Human-readable description
     * @param cause      Root cause
     */
    public AtlaSentException(int statusCode, String message, Throwable cause) {
        super(message, cause);
        this.statusCode = statusCode;
    }

    /**
     * Returns the HTTP status code associated with this exception.
     * Returns {@code 0} when the exception arose from a network-level failure
     * rather than an HTTP response.
     */
    public int getStatusCode() {
        return statusCode;
    }
}
