import { promises as fs } from 'fs';
import { join, extname, relative } from 'path';
import walk from 'walk';
import ignore from 'ignore';
import { CodeChunk, IndexingOptions } from './types';

export class CodeIndexer {
  private options: IndexingOptions;
  private ig: ReturnType<typeof ignore>;

  constructor(options: IndexingOptions) {
    this.options = options;
    this.ig = ignore().add(options.excludePatterns);
  }

  async indexDirectory(rootPath: string, projectId: string): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];
    const files = await this.getFilesToIndex(rootPath);

    for (const filePath of files) {
      try {
        const fileChunks = await this.processFile(filePath, rootPath, projectId);
        chunks.push(...fileChunks);
      } catch (error) {
        console.error(`Error processing file ${filePath}:`, error);
      }
    }

    return chunks;
  }

  private async getFilesToIndex(rootPath: string): Promise<string[]> {
    const files: string[] = [];

    return new Promise((resolve) => {
      const walker = walk.walk(rootPath);

      walker.on('file', (root, fileStats, next) => {
        const filePath = join(root, fileStats.name);
        const relativePath = relative(rootPath, filePath);

        if (!this.ig.ignores(relativePath) && this.shouldIncludeFile(filePath)) {
          files.push(filePath);
        }
        next();
      });

      walker.on('end', () => {
        resolve(files);
      });
    });
  }

  private shouldIncludeFile(filePath: string): boolean {
    const ext = extname(filePath);
    return this.options.includeExtensions.includes(ext);
  }

  private async processFile(filePath: string, rootPath: string, projectId: string): Promise<CodeChunk[]> {
    const content = await fs.readFile(filePath, 'utf-8');
    const relativePath = relative(rootPath, filePath);
    const language = this.getLanguageFromExtension(extname(filePath));

    return this.chunkContent(content, filePath, relativePath, language, projectId);
  }

  private chunkContent(content: string, filePath: string, relativePath: string, language: string, projectId: string): CodeChunk[] {
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];
    
    let currentChunk = '';
    let startLine = 1;
    let currentLine = 1;

    for (const line of lines) {
      currentChunk += line + '\n';

      if (currentChunk.length >= this.options.chunkSize) {
        chunks.push({
          id: this.generateChunkId(relativePath, startLine, currentLine),
          projectId,
          filePath,
          relativePath,
          content: currentChunk.trim(),
          startLine,
          endLine: currentLine,
          language
        });

        const overlapLines = Math.ceil(this.options.chunkOverlap / (currentChunk.length / (currentLine - startLine + 1)));
        const overlapStart = Math.max(startLine, currentLine - overlapLines + 1);
        
        currentChunk = lines.slice(overlapStart - 1, currentLine).join('\n') + '\n';
        startLine = overlapStart;
      }

      currentLine++;
    }

    if (currentChunk.trim()) {
      chunks.push({
        id: this.generateChunkId(relativePath, startLine, currentLine - 1),
        projectId,
        filePath,
        relativePath,
        content: currentChunk.trim(),
        startLine,
        endLine: currentLine - 1,
        language
      });
    }

    return chunks;
  }

  private generateChunkId(filePath: string, startLine: number, endLine: number): string {
    return `${filePath}:${startLine}-${endLine}`;
  }

  private getLanguageFromExtension(ext: string): string {
    const languageMap: Record<string, string> = {
      '.js': 'javascript',
      '.ts': 'typescript',
      '.jsx': 'javascript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.java': 'java',
      '.cpp': 'cpp',
      '.c': 'c',
      '.h': 'c',
      '.go': 'go',
      '.rs': 'rust',
      '.php': 'php',
      '.rb': 'ruby',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.cs': 'csharp',
      '.html': 'html',
      '.css': 'css',
      '.scss': 'scss',
      '.less': 'less',
      '.vue': 'vue',
      '.svelte': 'svelte',
      '.json': 'json',
      '.yml': 'yaml',
      '.yaml': 'yaml',
      '.md': 'markdown'
    };

    return languageMap[ext] || 'text';
  }
}