

export interface BazelTestTarget {
    target: string;
    type: string;
    location?: string;
    tags?: string[];
    srcs?: string[];
    timeout?: string;
    size?: string;
    flaky?: boolean;
    toolchain?: string;
    compatiblePlatforms?: string[];
    visibility?: string[];
}