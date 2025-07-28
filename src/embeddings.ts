import OpenAI from 'openai';
import { CodeChunk } from './types.js';
import { openaiConfig } from './config.js';

export class EmbeddingService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: openaiConfig.apiKey
    });
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.openai.embeddings.create({
        model: openaiConfig.model,
        input: text
      });

      return response.data[0].embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      const response = await this.openai.embeddings.create({
        model: openaiConfig.model,
        input: texts
      });

      return response.data.map(item => item.embedding);
    } catch (error) {
      console.error('Error generating embeddings:', error);
      throw error;
    }
  }

  async embedCodeChunks(chunks: CodeChunk[]): Promise<CodeChunk[]> {
    const batchSize = 100;
    const embeddedChunks: CodeChunk[] = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map(chunk => this.prepareTextForEmbedding(chunk));
      
      try {
        const embeddings = await this.generateEmbeddings(texts);
        
        const batchWithEmbeddings = batch.map((chunk, index) => ({
          ...chunk,
          embedding: embeddings[index]
        }));

        embeddedChunks.push(...batchWithEmbeddings);
        
        console.log(`Processed embeddings for batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chunks.length / batchSize)}`);
      } catch (error) {
        console.error(`Error processing batch ${i / batchSize + 1}:`, error);
        throw error;
      }
    }

    return embeddedChunks;
  }

  private prepareTextForEmbedding(chunk: CodeChunk): string {
    return `File: ${chunk.filePath}
Language: ${chunk.language}
Lines: ${chunk.startLine}-${chunk.endLine}

${chunk.content}`;
  }

  calculateSimilarity(embedding1: number[], embedding2: number[]): number {
    if (embedding1.length !== embedding2.length) {
      throw new Error('Embeddings must have the same length');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      norm1 += embedding1[i] * embedding1[i];
      norm2 += embedding2[i] * embedding2[i];
    }

    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }
}