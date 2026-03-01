export interface FileState {
	label: string;
	content: string;
	commit?: {
		hash: string;
		title: string;
		authorName: string;
		authorEmail: string;
		date: string;
		body: string;
	};
}

export interface DiffChunk {
	tag: string;
	start_a: number;
	end_a: number;
	start_b: number;
	end_b: number;
}
