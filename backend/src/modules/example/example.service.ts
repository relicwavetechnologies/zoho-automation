import { BaseService } from '../../core/service';
import { Example } from './example.model';
import { exampleRepository, ExampleRepository } from './example.repository';
import { CreateExampleDto } from './dto/create-example.dto';

export class ExampleService extends BaseService {
  constructor(private readonly repository: ExampleRepository = exampleRepository) {
    super();
  }

  createExample(payload: CreateExampleDto): Promise<Example> {
    return this.repository.create(payload);
  }

  getExamples(): Promise<Example[]> {
    return this.repository.findAll();
  }
}

export const exampleService = new ExampleService();


