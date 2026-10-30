export interface Repository { readonly name: string; readonly path: string }

export declare const git: {
    checkout(project: string, options: { branch: string }): Promise<Repository>;
    commitAll(repository: Repository, message: string): Promise<void>;
    push(repository: Repository): Promise<void>;
};
