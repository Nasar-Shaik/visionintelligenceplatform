import { describe, expect, it } from 'vitest';
import { CapabilityDescriptor, CapabilityRegistryRecord } from '../src/capability/descriptor.js';

const descriptor = {
  id: 'perception.person-detection',
  version: '2.3.0',
  kind: 'perception',
  inputs: [{ type: 'media.frame', rate: 'adaptive' }],
  outputs: [{ type: 'perception.detection' }],
  models: { selector: { task: 'object-detection', family: 'yolo' } },
  placement: ['edge', 'cloud'],
  generatedEvents: ['perception.person.detected'],
};

describe('CapabilityDescriptor', () => {
  it('parses a valid descriptor and applies defaults', () => {
    const d = CapabilityDescriptor.parse(descriptor);
    expect(d.resourceProfile.accelerator).toEqual(['cpu']);
    expect(d.extensionPoints).toEqual([]);
  });

  it('rejects a malformed capability id (must be <family>.<name>)', () => {
    expect(() => CapabilityDescriptor.parse({ ...descriptor, id: 'PersonDetection' })).toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => CapabilityDescriptor.parse({ ...descriptor, kind: 'vertical' })).toThrow();
  });

  it('registry record requires owner + description and defaults lifecycle to experimental', () => {
    const rec = CapabilityRegistryRecord.parse({
      ...descriptor,
      owner: 'vision-team',
      description: 'Detect people in frames.',
    });
    expect(rec.lifecycleState).toBe('experimental');
    expect(() => CapabilityRegistryRecord.parse(descriptor)).toThrow(); // missing owner/description
  });
});
