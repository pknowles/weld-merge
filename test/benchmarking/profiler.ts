import fs from "node:fs";
import inspector from "node:inspector";

export async function withProfiling<T>(
	profilePath: string,
	fn: () => Promise<T>,
): Promise<{ result: T; profilePath: string }> {
	const session = new inspector.Session();
	session.connect();

	await new Promise<void>((resolve, reject) => {
		session.post("Profiler.enable", (err) => {
			if (err) {
				reject(err);
			} else {
				session.post("Profiler.start", (err2) => {
					if (err2) {
						reject(err2);
					} else {
						resolve();
					}
				});
			}
		});
	});

	try {
		const result = await fn();
		return await new Promise((resolve, reject) => {
			session.post("Profiler.stop", (err, { profile }) => {
				if (err) {
					reject(err);
					return;
				}
				fs.writeFileSync(profilePath, JSON.stringify(profile));
				session.disconnect();
				resolve({ result, profilePath });
			});
		});
	} catch (e) {
		session.disconnect();
		throw e;
	}
}
