import { FileStorageOption, FileStorageProviderEnum, UploadedFile } from '@gauzy/contracts';
import * as multer from 'multer';
import * as fs from 'fs';
import * as moment from 'moment';
import { environment, getConfig } from '@gauzy/config';
import { Provider } from './provider';
import { basename, join, resolve } from 'path';

const config = getConfig();

export class LocalProvider extends Provider<LocalProvider> {
	static instance: LocalProvider;
	name = FileStorageProviderEnum.LOCAL;
	tenantId = '';
	config = {
		rootPath: environment.isElectron
			? resolve(environment.gauzyUserPath, 'public')
			: config.assetOptions.assetPublicPath ||
			resolve(process.cwd(), 'apps', 'api', 'public'),
		baseUrl: environment.baseUrl + '/public'
	};

	getInstance() {
		if (!LocalProvider.instance) {
			LocalProvider.instance = new LocalProvider();
		}
		return LocalProvider.instance;
	}

	url(filePath: string) {
		if (filePath && filePath.startsWith('http')) {
			return filePath;
		}
		return filePath ? `${this.config.baseUrl}/${filePath}` : null;
	}

	path(filePath: string) {
		return filePath ? `${this.config.rootPath}/${filePath}` : null;
	}

	handler({
		dest,
		filename,
		prefix = 'file'
	}: FileStorageOption): multer.StorageEngine {
		return multer.diskStorage({
			destination: (_req, file, callback) => {
				// A string or function that determines the destination path for uploaded
				let dir: string;
				if (dest instanceof Function) {
					dir = dest(file);
				} else {
					dir = dest;
				}

				const fullPath = join(this.config.rootPath, dir);
				fs.mkdirSync(fullPath, { recursive: true });

				callback(null, fullPath);
			},
			filename: (_req, file, callback) => {
				// A file extension, or filename extension, is a suffix at the end of a file.
				const extension = file.originalname.split('.').pop();

				// A function that determines the name of the uploaded file.
				let fileName: string;
				if (filename) {
					if (typeof filename === 'string') {
						fileName = filename;
					} else {
						fileName = filename(file, extension);
					}
				} else {
					fileName = `${prefix}-${moment().unix()}-${parseInt('' + Math.random() * 1000, 10)}.${extension}`;
				}
				callback(null, fileName);
			}
		});
	}

	async getFile(file: string): Promise<Buffer> {
		return await fs.promises.readFile(this.path(file));
	}

	async deleteFile(file: string): Promise<void> {
		if (fs.existsSync(this.path(file))) {
			return fs.unlinkSync(this.path(file));
		}
	}

	async putFile(fileContent: any, path: string = ''): Promise<UploadedFile> {
		return new Promise((putFileResolve, reject) => {
			const fullPath = join(this.config.rootPath, path);
			fs.writeFile(fullPath, fileContent, (err) => {
				if (err) {
					reject(err);
					return;
				}

				const stats = fs.statSync(fullPath);
				const baseName = basename(path);
				const file = {
					originalname: baseName,
					size: stats.size,
					filename: baseName,
					path: fullPath
				};
				putFileResolve(this.mapUploadedFile(file));
			});
		});
	}

	mapUploadedFile(file): UploadedFile {
		const separator = process.platform === 'win32' ? '\\' : '/';

		if (file.path) {
			file.key = file.path.replace(this.config.rootPath + separator, '');
		}

		file.url = this.url(file.key);
		return file;
	}
}
