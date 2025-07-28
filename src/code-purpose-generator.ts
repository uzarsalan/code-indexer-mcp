import OpenAI from 'openai';
import { CodeChunk } from './types.js';
import { openaiConfig } from './config.js';

export class CodePurposeGenerator {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: openaiConfig.apiKey
    });
  }

  async generatePurpose(chunk: CodeChunk): Promise<string> {
    try {
      const prompt = this.buildPurposePrompt(chunk);
      
      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'You are a code analysis expert. Analyze the given code and provide a concise, clear description of what it does. Focus on the functional purpose, not implementation details. Keep it under 50 words.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 100,
        temperature: 0.3
      });

      return response.choices[0]?.message?.content?.trim() || 'Code block';
    } catch (error) {
      console.error('Error generating code purpose:', error);
      return this.fallbackPurpose(chunk);
    }
  }

  async generatePurposeBatch(chunks: CodeChunk[]): Promise<CodeChunk[]> {
    const batchSize = 5; // Process in smaller batches to avoid rate limits
    const enhancedChunks: CodeChunk[] = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (chunk) => {
        const purpose = await this.generatePurpose(chunk);
        return { ...chunk, purpose };
      });

      try {
        const batchResults = await Promise.all(batchPromises);
        enhancedChunks.push(...batchResults);
        
        // Add delay to respect rate limits
        if (i + batchSize < chunks.length) {
          await this.delay(1000); // 1 second delay between batches
        }
        
        console.log(`Generated purposes for batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chunks.length / batchSize)}`);
      } catch (error) {
        console.error(`Error processing batch ${i / batchSize + 1}:`, error);
        // Fallback: add chunks without purposes
        enhancedChunks.push(...batch.map(chunk => ({
          ...chunk,
          purpose: this.fallbackPurpose(chunk)
        })));
      }
    }

    return enhancedChunks;
  }

  private buildPurposePrompt(chunk: CodeChunk): string {
    let prompt = `Analyze this ${chunk.language} code and describe what it does:

File: ${chunk.relativePath}`;

    if (chunk.nodeType) {
      prompt += `\nType: ${chunk.nodeType}`;
    }

    if (chunk.functionName) {
      prompt += `\nFunction: ${chunk.functionName}`;
    }

    if (chunk.className) {
      prompt += `\nClass: ${chunk.className}`;
    }

    if (chunk.parameters && chunk.parameters.length > 0) {
      prompt += `\nParameters: ${chunk.parameters.join(', ')}`;
    }

    prompt += `\n\nCode:\n${chunk.content}

Provide a concise description of what this code does:`;

    return prompt;
  }

  private fallbackPurpose(chunk: CodeChunk): string {
    // Generate basic purpose based on available metadata
    if (chunk.functionName) {
      return `Function ${chunk.functionName} implementation`;
    }
    
    if (chunk.className) {
      return `Class ${chunk.className} definition`;
    }
    
    if (chunk.nodeType === 'interface') {
      return 'Interface definition';
    }
    
    if (chunk.nodeType === 'type') {
      return 'Type definition';
    }
    
    if (chunk.nodeType === 'module') {
      return 'Module definition';
    }

    // Analyze content for basic patterns
    const content = chunk.content.toLowerCase();
    
    if (content.includes('export') && content.includes('function')) {
      return 'Exported function';
    }
    
    if (content.includes('class') && content.includes('constructor')) {
      return 'Class with constructor';
    }
    
    if (content.includes('interface') && content.includes('{')) {
      return 'Interface type definition';
    }
    
    if (content.includes('async') && content.includes('await')) {
      return 'Asynchronous function';
    }
    
    if (content.includes('import') || content.includes('require')) {
      return 'Module imports and dependencies';
    }

    return `${chunk.language} code block`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}