import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import { CodeChunk } from './types.js';

export interface ASTNode {
  type: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  text: string;
  children?: ASTNode[];
}

export interface SemanticInfo {
  nodeType: CodeChunk['nodeType'];
  functionName?: string;
  className?: string;
  parameters?: string[];
  returnType?: string;
  dependencies?: string[];
  docstring?: string;
  complexity?: number;
}

export class ASTAnalyzer {
  private parsers: Map<string, Parser> = new Map();

  constructor() {
    this.initializeParsers();
  }

  private initializeParsers(): void {
    // TypeScript
    const tsParser = new Parser();
    tsParser.setLanguage(TypeScript.typescript);
    this.parsers.set('typescript', tsParser);

    // JavaScript
    const jsParser = new Parser();
    jsParser.setLanguage(JavaScript);
    this.parsers.set('javascript', jsParser);

    // Go
    const goParser = new Parser();
    goParser.setLanguage(Go);
    this.parsers.set('go', goParser);

    // Rust
    const rustParser = new Parser();
    rustParser.setLanguage(Rust);
    this.parsers.set('rust', rustParser);
  }

  parseCode(code: string, language: string): ASTNode | null {
    const parser = this.parsers.get(language);
    if (!parser) {
      console.warn(`No parser available for language: ${language}`);
      return null;
    }

    try {
      const tree = parser.parse(code);
      return this.convertToASTNode(tree.rootNode);
    } catch (error) {
      console.error(`Error parsing ${language} code:`, error);
      return null;
    }
  }

  private convertToASTNode(node: any): ASTNode {
    return {
      type: node.type,
      startPosition: node.startPosition,
      endPosition: node.endPosition,
      text: node.text,
      children: node.children?.map((child: any) => this.convertToASTNode(child))
    };
  }

  extractSemanticChunks(code: string, language: string, filePath: string, projectId: string): CodeChunk[] {
    const ast = this.parseCode(code, language);
    if (!ast) {
      // Fallback to simple chunking if AST parsing fails
      return this.fallbackChunking(code, filePath, projectId, language);
    }

    const chunks: CodeChunk[] = [];
    const lines = code.split('\n');
    
    this.extractChunksFromNode(ast, chunks, lines, filePath, projectId, language);
    
    return chunks;
  }

  private extractChunksFromNode(
    node: ASTNode, 
    chunks: CodeChunk[], 
    lines: string[], 
    filePath: string, 
    projectId: string, 
    language: string,
    depth: number = 0
  ): void {
    // Extract semantic information for significant nodes
    const semanticInfo = this.extractSemanticInfo(node, language);
    
    if (this.isSignificantNode(node.type, language)) {
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const content = lines.slice(startLine - 1, endLine).join('\n');
      
      if (content.trim()) {
        chunks.push({
          id: this.generateChunkId(filePath, startLine, endLine, node.type),
          projectId,
          filePath,
          relativePath: filePath,
          content,
          startLine,
          endLine,
          language,
          ...semanticInfo
        });
      }
    }

    // Recursively process children, but avoid too deep nesting
    if (node.children && depth < 3) {
      for (const child of node.children) {
        this.extractChunksFromNode(child, chunks, lines, filePath, projectId, language, depth + 1);
      }
    }
  }

  private isSignificantNode(nodeType: string, language: string): boolean {
    const significantTypes = {
      typescript: [
        'function_declaration', 'method_definition', 'class_declaration',
        'interface_declaration', 'type_alias_declaration', 'arrow_function',
        'function_expression', 'export_statement'
      ],
      javascript: [
        'function_declaration', 'method_definition', 'class_declaration',
        'arrow_function', 'function_expression', 'export_statement'
      ],
      go: [
        'function_declaration', 'method_declaration', 'type_declaration',
        'struct_type', 'interface_type'
      ],
      rust: [
        'function_item', 'impl_item', 'struct_item', 'enum_item',
        'trait_item', 'mod_item'
      ]
    };

    return significantTypes[language as keyof typeof significantTypes]?.includes(nodeType) || false;
  }

  private extractSemanticInfo(node: ASTNode, language: string): SemanticInfo {
    const info: SemanticInfo = {
      nodeType: this.mapNodeTypeToChunkType(node.type, language)
    };

    // Extract function/method names
    if (node.type.includes('function') || node.type.includes('method')) {
      info.functionName = this.extractFunctionName(node);
      info.parameters = this.extractParameters(node);
      info.returnType = this.extractReturnType(node);
    }

    // Extract class names
    if (node.type.includes('class')) {
      info.className = this.extractClassName(node);
    }

    // Extract docstrings/comments
    info.docstring = this.extractDocstring(node);

    // Calculate complexity (simplified)
    info.complexity = this.calculateComplexity(node);

    return info;
  }

  private mapNodeTypeToChunkType(nodeType: string, language: string): CodeChunk['nodeType'] {
    if (nodeType.includes('function')) return 'function';
    if (nodeType.includes('method')) return 'method';
    if (nodeType.includes('class')) return 'class';
    if (nodeType.includes('interface')) return 'interface';
    if (nodeType.includes('type')) return 'type';
    if (nodeType.includes('module') || nodeType.includes('mod')) return 'module';
    return 'block';
  }

  private extractFunctionName(node: ASTNode): string | undefined {
    // Simple extraction - in real implementation, this would be more sophisticated
    const match = node.text.match(/(?:function\s+|const\s+|let\s+|var\s+)([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    return match?.[1];
  }

  private extractClassName(node: ASTNode): string | undefined {
    const match = node.text.match(/class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    return match?.[1];
  }

  private extractParameters(node: ASTNode): string[] {
    // Simplified parameter extraction
    const match = node.text.match(/\(([^)]*)\)/);
    if (match?.[1]) {
      return match[1].split(',').map(p => p.trim()).filter(p => p);
    }
    return [];
  }

  private extractReturnType(node: ASTNode): string | undefined {
    // TypeScript return type extraction
    const match = node.text.match(/:\s*([^{]+?)\s*[{=]/);
    return match?.[1]?.trim();
  }

  private extractDocstring(node: ASTNode): string | undefined {
    // Look for comments above the node
    const lines = node.text.split('\n');
    const docLines: string[] = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('/**') || trimmed.startsWith('/*') || 
          trimmed.startsWith('//') || trimmed.startsWith('*')) {
        docLines.push(trimmed);
      } else if (docLines.length > 0) {
        break;
      }
    }
    
    return docLines.length > 0 ? docLines.join('\n') : undefined;
  }

  private calculateComplexity(node: ASTNode): number {
    // Simplified cyclomatic complexity
    let complexity = 1;
    const complexityKeywords = ['if', 'else', 'while', 'for', 'switch', 'catch', 'case'];
    
    for (const keyword of complexityKeywords) {
      const matches = node.text.match(new RegExp(`\\b${keyword}\\b`, 'g'));
      if (matches) {
        complexity += matches.length;
      }
    }
    
    return complexity;
  }

  private fallbackChunking(code: string, filePath: string, projectId: string, language: string): CodeChunk[] {
    // Fallback to simple line-based chunking
    const lines = code.split('\n');
    const chunkSize = 50; // lines per chunk
    const chunks: CodeChunk[] = [];

    for (let i = 0; i < lines.length; i += chunkSize) {
      const endLine = Math.min(i + chunkSize, lines.length);
      const content = lines.slice(i, endLine).join('\n');
      
      chunks.push({
        id: this.generateChunkId(filePath, i + 1, endLine, 'block'),
        projectId,
        filePath,
        relativePath: filePath,
        content,
        startLine: i + 1,
        endLine,
        language,
        nodeType: 'block'
      });
    }

    return chunks;
  }

  private generateChunkId(filePath: string, startLine: number, endLine: number, nodeType: string): string {
    return `${filePath}:${startLine}-${endLine}:${nodeType}`;
  }
}