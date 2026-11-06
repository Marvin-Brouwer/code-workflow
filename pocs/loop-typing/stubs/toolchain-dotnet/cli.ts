import type { Repository } from '@mesh-flow/git';

export declare const cli: {
    build(repository: string): Promise<{ succeeded: boolean; log: string }>;
    test(repository: string | Repository, filter?: string): Promise<{ failures: readonly string[] }>;
    updatePackages(repository: Repository, packages: readonly string[]): Promise<void>;
    virusScan(repository: Repository): Promise<{ detections: readonly string[] }>;
    auditPackages(repository: Repository): Promise<{ vulnerable: readonly string[] }>;
};
