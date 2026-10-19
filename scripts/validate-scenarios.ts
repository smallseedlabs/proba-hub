#!/usr/bin/env tsx
/**
 * Validate all YAML scenario files against the proba-protocol BrainOutput schema
 */
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import yaml from 'js-yaml';
import { isBrainOutput } from '@smallseedlabs/proba-protocol';

const SCENARIOS_DIR = join(process.cwd(), 'src', 'brain', 'scenarios');
const SKIP_VALIDATION = ['malformed_output.yaml']; // Intentionally invalid for testing

interface ScenarioStep {
  trigger: unknown;
  outputs: unknown[];
}

interface Scenario {
  name: string;
  description: string;
  steps: ScenarioStep[];
}

async function validateScenarios() {
  console.log('Validating scenario files...\n');
  
  const files = await readdir(SCENARIOS_DIR);
  const yamlFiles = files.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  
  let hasErrors = false;
  
  for (const file of yamlFiles) {
    if (SKIP_VALIDATION.includes(file)) {
      console.log(`⊘ ${file}: Skipped (intentionally invalid)\n`);
      continue;
    }
    
    const filePath = join(SCENARIOS_DIR, file);
    const content = await readFile(filePath, 'utf-8');
    
    try {
      const scenario = yaml.load(content) as Scenario;
      
      console.log(`✓ ${file}: Parsed successfully`);
      console.log(`  Name: ${scenario.name}`);
      console.log(`  Steps: ${scenario.steps.length}`);
      
      // Validate each output in each step
      for (let i = 0; i < scenario.steps.length; i++) {
        const step = scenario.steps[i];
        
        for (let j = 0; j < step.outputs.length; j++) {
          const output = step.outputs[j];
          
          if (!isBrainOutput(output)) {
            console.error(`  ✗ Step ${i}, Output ${j}: Invalid BrainOutput`);
            console.error(`    Output:`, JSON.stringify(output, null, 2));
            hasErrors = true;
          } else {
            console.log(`  ✓ Step ${i}, Output ${j}: Valid ${(output as { type: string }).type}`);
          }
        }
      }
      
      console.log('');
    } catch (error) {
      console.error(`✗ ${file}: Failed to parse`);
      console.error(`  Error: ${(error as Error).message}`);
      hasErrors = true;
      console.log('');
    }
  }
  
  if (hasErrors) {
    console.error('❌ Validation failed - some scenarios have invalid outputs');
    process.exit(1);
  } else {
    console.log('✅ All scenarios are valid!');
    process.exit(0);
  }
}

validateScenarios().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
