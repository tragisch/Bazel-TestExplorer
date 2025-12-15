/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

/**
 * Error handler - categorizes and handles errors with retry logic and user-friendly messages
 */

import { logWithTimestamp } from '../logging';

/**
 * Error categories
 */
export type ErrorCategory = 'bazel' | 'workspace' | 'validation' | 'cache' | 'unknown';

/**
 * Error handling result
 */
export interface ErrorResult {
  category: ErrorCategory;
  userMessage: string;
  shouldRetry: boolean;
  logMessage: string;
  originalError?: Error;
}

/**
 * Central error handler for structured error management
 */
export class ErrorHandler {
  /**
   * Process error based on context
   */
  handle(
    error: unknown,
    context: 'query' | 'run' | 'validation' | 'discovery'
  ): ErrorResult {
    const originalError = error instanceof Error ? error : new Error(String(error));

    // Check validation errors first (before Bazel check!)
    if (this.isValidationError(error)) {
      return this.handleValidationError(originalError, context);
    }

    // Bazel-specific errors
    if (this.isBazelError(error)) {
      return this.handleBazelError(originalError, context);
    }

    // Workspace-Fehler
    if (this.isWorkspaceError(error)) {
      return this.handleWorkspaceError(originalError, context);
    }

    // Unbekannte Fehler
    return this.handleUnknownError(originalError, context);
  }

  /**
   * Check if Bazel error
   */
  private isBazelError(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return (
      message.includes('bazel') ||
      message.includes('exit code') ||
      message.includes('query') ||
      message.includes('target')
    );
  }

  /**
   * Check if workspace error
   */
  private isWorkspaceError(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return (
      message.includes('workspace') ||
      message.includes('enoent') ||
      message.includes('no such file')
    );
  }

  /**
   * Check if validation error
   */
  private isValidationError(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return (
      message.includes('invalid configuration') ||
      message.includes('not available') ||
      message.includes('version')
    );
  }

  /**
   * Handle Bazel errors
   */
  private handleBazelError(error: Error, context: string): ErrorResult {
    const shouldRetry = this.isTransientError(error);

    return {
      category: 'bazel',
      userMessage: `Bazel error in ${context}: ${this.extractMessage(error)}`,
      shouldRetry,
      logMessage: `Bazel ${context} error: ${error.message}`,
      originalError: error
    };
  }

  /**
   * Handle workspace errors
   */
  private handleWorkspaceError(error: Error, context: string): ErrorResult {
    // Workspace errors usually NOT retryable (missing files, not transient)
    const shouldRetry = this.isTransientError(error);
    
    return {
      category: 'workspace',
      userMessage: 'Bazel workspace not accessible. Check workspace configuration.',
      shouldRetry,
      logMessage: `Workspace error in ${context}: ${error.message}`,
      originalError: error
    };
  }

  /**
   * Handle validation errors
   */
  private handleValidationError(error: Error, context: string): ErrorResult {
    return {
      category: 'validation',
      userMessage: 'Bazel validation failed. Check Bazel installation and PATH.',
      shouldRetry: false,
      logMessage: `Validation error in ${context}: ${error.message}`,
      originalError: error
    };
  }

  /**
   * Handle unknown errors
   */
  private handleUnknownError(error: Error, context: string): ErrorResult {
    return {
      category: 'unknown',
      userMessage: `Unexpected error in ${context}: ${this.extractMessage(error)}`,
      shouldRetry: true,
      logMessage: `Unknown error in ${context}: ${error.message}`,
      originalError: error
    };
  }

  /**
   * Check if error is transient (retry makes sense)
   */
  private isTransientError(error: Error): boolean {
    const message = error.message.toLowerCase();
    const errorCode = (error as any).code;

    // Check error.code property for Node.js errors
    if (errorCode) {
      const transientCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH'];
      if (transientCodes.includes(errorCode)) {
        return true;
      }
      // ENOENT and other file system errors are NOT transient
      if (errorCode === 'ENOENT' || errorCode === 'EACCES') {
        return false;
      }
    }

    return (
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('temporary') ||
      message.includes('busy')
    );
  }

  /**
   * Extrahiert die Message aus verschiedenen Error-Typen
   */
  private extractMessage(error: Error | unknown): string {
    if (error instanceof Error) {
      return error.message || error.toString();
    }
    return String(error);
  }

  /**
   * Loggt einen Fehler strukturiert
   */
  logError(result: ErrorResult, tag?: string): void {
    const prefix = tag ? `[${tag}]` : '[Error]';
    logWithTimestamp(`${prefix} ${result.category}: ${result.logMessage}`, 'error');
  }
}
