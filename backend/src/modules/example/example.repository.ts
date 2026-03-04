import { randomUUID } from 'crypto';

import { BaseRepository } from '../../core/repository';
import { Example } from './example.model';
import { CreateExampleDto } from './dto/create-example.dto';

export class ExampleRepository extends BaseRepository {
  private examples: Example[] = [];

  async create(payload: CreateExampleDto): Promise<Example> {
    const example: Example = {
      id: randomUUID(),
      name: payload.name,
      description: payload.description,
      createdAt: new Date(),
    };

    this.examples.push(example);
    return example;
  }

  async findAll(): Promise<Example[]> {
    return this.examples;
  }
}

export const exampleRepository = new ExampleRepository();


