import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { getJenkinsBaseUrl, getJenkinsJobPathTemplate } from '../config';
import { JenkinsBuildStatus } from '../types';

export class JenkinsService {
  public async getBranchStatus(branchName: string, scope?: vscode.ConfigurationScope): Promise<JenkinsBuildStatus | undefined> {
    const baseUrl = getJenkinsBaseUrl(scope).trim();
    if (!baseUrl) {
      return undefined;
    }

    const template = getJenkinsJobPathTemplate(scope);
    const apiUrl = new URL(template.replace('{branch}', encodeURIComponent(branchName)), this.ensureTrailingSlash(baseUrl));
    const payload = await this.fetchJson(apiUrl);
    if (!payload || typeof payload !== 'object') {
      return undefined;
    }

    const color = String((payload as Record<string, unknown>).color ?? 'notbuilt');
    const result = String((payload as Record<string, unknown>).result ?? color);
    return {
      label: `Jenkins: ${result}`,
      color,
      url: String((payload as Record<string, unknown>).url ?? apiUrl.toString()),
    };
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.get(url, (response) => {
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`Jenkins returned status ${response.statusCode ?? 500}`));
          return;
        }

        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      });

      request.on('error', reject);
      request.end();
    });
  }

  private ensureTrailingSlash(value: string): string {
    return value.endsWith('/') ? value : `${value}/`;
  }
}