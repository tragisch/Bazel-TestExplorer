/*
 * Copyright (c) 2025 @tragisch <https://github.com/tragisch>
 * SPDX-License-Identifier: MIT
 * 
 * This file is part of a project licensed under the MIT License.
 * See the LICENSE file in the root directory for details.
 */

import { logWithTimestamp } from '../logging';

/**
 * Kategorien für verschiedene Fehlertypen
 */
export type ErrorCategory = 'bazel' | 'workspace' | 'validation' | 'cache' | 'unknown';

/**
 * Fehlerbehandlungs-Ergebnis
 */
export interface ErrorResult {
  category: ErrorCategory;
  userMessage: string;
  shouldRetry: boolean;
  logMessage: string;
  originalError?: Error;
}

/**
 * Zentrale Fehlerbehandlungs-Klasse für strukturierte Error-Verwaltung
 */
export class ErrorHandler {
  /**
   * Verarbeitet einen Fehler basierend auf Kontext
   */
  handle(
    error: unknown,
    context: 'query' | 'run' | 'validation' | 'discovery'
  ): ErrorResult {
    const originalError = error instanceof Error ? error : new Error(String(error));

    // Validation-Fehler ZUERST prüfen (bevor Bazel-Check!)
    if (this.isValidationError(error)) {
      return this.handleValidationError(originalError, context);
    }

    // Bazel-spezifische Fehler
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
   * Prüft, ob es ein Bazel-Fehler ist
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
   * Prüft, ob es ein Workspace-Fehler ist
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
   * Prüft, ob es ein Validation-Fehler ist
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
   * Behandelt Bazel-Fehler
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
   * Behandelt Workspace-Fehler
   */
  private handleWorkspaceError(error: Error, context: string): ErrorResult {
    // Workspace-Fehler sind normalerweise NICHT retryable (Datei fehlt, nicht vor\u00fcbergehend)
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
   * Behandelt Validation-Fehler
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
   * Behandelt unbekannte Fehler
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
   * Prüft, ob ein Fehler transient ist (Retry sinnvoll)
   */
  private isTransientError(error: Error): boolean {
    const message = error.message.toLowerCase();
    const errorCode = (error as any).code;

    // Prüfe error.code Property für Node.js Fehler
    if (errorCode) {
      const transientCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH'];
      if (transientCodes.includes(errorCode)) {
        return true;
      }
      // ENOENT und andere File-System-Fehler sind NICHT transient
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
