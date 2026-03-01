export interface FileState {
	label: string;
	content: string;
	commit?: {
		hash: string;
		title: string;
	};
}

export interface DiffChunk {
	tag: string;
	start_a: number;
	end_a: number;
	start_b: number;
	end_b: number;
}
