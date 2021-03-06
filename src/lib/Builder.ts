
import { dirname, basename, resolve } from 'path';

import * as semver from 'semver';
import { ensureDirAsync, emptyDir, readFileAsync, readJsonAsync, writeFileAsync, copyAsync, removeAsync, createReadStream, createWriteStream, renameAsync } from 'fs-extra-promise';
import * as Bluebird from 'bluebird';

const debug = require('debug')('build:builder');
const globby = require('globby');
const rcedit = require('rcedit');
const plist = require('plist');

import { Downloader } from './Downloader';
import { FFmpegDownloader } from './FFmpegDownloader';
import { BuildConfig } from './config';
import { NsisVersionInfo } from './common';
import { NsisComposer, NsisDiffer, Nsis7Zipper, nsisBuild } from './nsis-gen';
import { mergeOptions, findExecutable, findFFmpeg, findRuntimeRoot, findExcludableDependencies, tmpName, tmpFile, tmpDir, fixWindowsVersion, copyFileAsync, extractGeneric, compress } from './util';

interface IBuilderOptions {
    win?: boolean;
    mac?: boolean;
    linux?: boolean;
    x86?: boolean;
    x64?: boolean;
    chromeApp?: boolean;
    mirror?: string;
    concurrent?: boolean;
    mute?: boolean;
}

export class Builder {

    public static DEFAULT_OPTIONS: IBuilderOptions = {
        win: false,
        mac: false,
        linux: false,
        x86: false,
        x64: false,
        chromeApp: false,
        mirror: Downloader.DEFAULT_OPTIONS.mirror,
        concurrent: false,
        mute: true,
    };

    public options: IBuilderOptions;

    constructor(options: IBuilderOptions = {}, public dir: string) {

        this.options = mergeOptions(Builder.DEFAULT_OPTIONS, options);

        debug('in constructor', 'dir', dir);
        debug('in constructor', 'options', this.options);

    }

    public async build() {

        const tasks: string[][] = [];

        [ 'win', 'mac', 'linux' ].map((platform) => {
            [ 'x86', 'x64' ].map((arch) => {
                if((<any>this.options)[platform] && (<any>this.options)[arch]) {
                    tasks.push([ platform, arch ]);
                }
            });
        });

        if(!this.options.mute) {
            console.info('Starting building tasks...', {
                tasks,
                concurrent: this.options.concurrent,
            });
        }

        if(tasks.length == 0) {
            throw new Error('ERROR_NO_TASK');
        }

        if(this.options.concurrent) {

            await Bluebird.map(tasks, async ([ platform, arch ]) => {

                const options: any = {};
                options[platform] = true;
                options[arch] = true;
                options.mirror = this.options.mirror;
                options.concurrent = false;
                options.mute = true;

                const builder = new Builder(options, this.dir);

                const started = Date.now();

                await builder.build();

                if(!this.options.mute) {
                    console.info(`Building for ${ platform }, ${ arch } ends within ${ this.getTimeDiff(started) }ms.`);
                }

            });

        }
        else {

            const pkg: any = await readJsonAsync(resolve(this.dir, this.options.chromeApp ? 'manifest.json' : 'package.json'));
            const config = new BuildConfig(pkg);

            debug('in build', 'config', config);

            for(const [ platform, arch ] of tasks) {

                const started = Date.now();

                await this.buildTask(platform, arch, pkg, config);

                if(!this.options.mute) {
                    console.info(`Building for ${ platform }, ${ arch } ends within ${ this.getTimeDiff(started) }ms.`);
                }

            }

        }

    }

    protected getTimeDiff(started: number) {
        return ((Date.now() - started) / 1000).toFixed(2);
    }

    protected combineExecutable(executable: string, nwFile: string) {
        return new Promise((resolve, reject) => {

            const nwStream = createReadStream(nwFile);
            const stream = createWriteStream(executable, {
                flags: 'a',
            });

            nwStream.on('error', reject);
            stream.on('error', reject);

            stream.on('finish', resolve);

            nwStream.pipe(stream);

        });
    }

    protected readPlist(path: string): Promise<any> {
        return readFileAsync(path, {
                encoding: 'utf-8',
        })
        .then(data => plist.parse(data));
    }

    protected writePlist(path: string, p: any) {
        return writeFileAsync(path, plist.build(p));
    }

    protected updateWinResources(targetDir: string, appRoot: string, pkg: any, config: BuildConfig) {

        const pathResolve = resolve;

        return new Promise((resolve, reject) => {

            const path = pathResolve(targetDir, 'nw.exe');

            const rc = {
                'product-version': fixWindowsVersion(config.win.productVersion),
                'file-version': fixWindowsVersion(config.win.fileVersion),
                'version-string': config.win.versionStrings,
                'icon': config.win.icon ? pathResolve(this.dir, config.win.icon) : undefined,
            };

            rcedit(path, rc, (err: Error) => err ? reject(err) : resolve());

        });
    }

    protected renameWinApp(targetDir: string, appRoot: string, pkg: any, config: BuildConfig) {

        const src = resolve(targetDir, 'nw.exe');
        const dest = resolve(targetDir, `${ config.win.versionStrings.ProductName }.exe`);

        return renameAsync(src, dest);

    }

    protected async updatePlist(targetDir: string, appRoot: string, pkg: any, config: BuildConfig) {

        const path = resolve(targetDir, './nwjs.app/Contents/Info.plist');

        const plist = await this.readPlist(path);

        plist.CFBundleIdentifier = config.appId;
        plist.CFBundleName = config.mac.name;
        plist.CFBundleDisplayName = config.mac.displayName;
        plist.CFBundleVersion = config.mac.version;
        plist.CFBundleShortVersionString = config.mac.version;

        await this.writePlist(path, plist);

    }

    protected async updateMacIcon(targetDir: string, appRoot: string, pkg: any, config: BuildConfig) {

        const path = resolve(targetDir, './nwjs.app/Contents/Resources/app.icns');

        if(!config.mac.icon) {
            return;
        }

        await copyAsync(resolve(this.dir, config.mac.icon), path);

    }

    protected async fixMacMeta(targetDir: string, appRoot: string, pkg: any, config: BuildConfig) {

        const files = await globby([ '**/InfoPlist.strings' ], {
            cwd: targetDir,
        });

        for(const file of files) {

            const path = resolve(targetDir, file);

            // Different versions has different encodings for `InforPlist.strings`.
            // We determine encoding by evaluating bytes of `CF` here.
            const data = await readFileAsync(path);
            const encoding = data.indexOf(Buffer.from('43004600', 'hex')) >= 0
            ? 'ucs2' : 'utf-8';

            const strings = data.toString(encoding);

            const newStrings = strings.replace(/([A-Za-z]+)\s+=\s+"(.+?)";/g, (match: string, key: string, value: string) => {
                switch(key) {
                case 'CFBundleName':
                    return `${ key } = "${ config.mac.name }";`;
                case 'CFBundleDisplayName':
                    return `${ key } = "${ config.mac.displayName }";`;
                case 'CFBundleGetInfoString':
                    return `${ key } = "${ config.mac.version }";`;
                case 'NSContactsUsageDescription':
                    return `${ key } = "${ config.mac.description }";`;
                case 'NSHumanReadableCopyright':
                    return `${ key } = "${ config.mac.copyright }";`;
                default:
                    return `${ key } = "${ value }";`;
                }
            });

            await writeFileAsync(path, Buffer.from(newStrings, encoding));

        }

    }

    protected renameMacApp(targetDir: string, appRoot: string, pkg: any, config: BuildConfig) {

            const src = resolve(targetDir, 'nwjs.app');
            const dest = resolve(targetDir, `${ config.mac.displayName }.app`);

            return renameAsync(src, dest);

    }

    protected renameLinuxApp(targetDir: string, appRoot: string, pkg: any, config: BuildConfig) {

        const src = resolve(targetDir, 'nw');
        const dest = resolve(targetDir, `${ pkg.name }`);

        return renameAsync(src, dest);

    }

    protected async prepareWinBuild(targetDir: string, appRoot: string, pkg: any, config: BuildConfig) {

        await this.updateWinResources(targetDir, appRoot, pkg, config);

    }

    protected async prepareMacBuild(targetDir: string, appRoot: string, pkg: any, config: BuildConfig) {

        await this.updatePlist(targetDir, appRoot, pkg, config);
        await this.updateMacIcon(targetDir, appRoot, pkg, config);
        await this.fixMacMeta(targetDir, appRoot, pkg, config);

    }

    protected async prepareLinuxBuild(targetDir: string, appRoot: string, pkg: any, config: BuildConfig) {

    }

    protected async copyFiles(platform: string, targetDir: string, appRoot: string, pkg: any, config: BuildConfig) {

        const generalExcludes = [
            '**/node_modules/.bin',
            '**/node_modules/*/{ example, examples, test, tests }',
            '**/{ .DS_Store, .git, .hg, .svn, *.log }',
        ];

        const dependenciesExcludes = await findExcludableDependencies(this.dir, pkg)
        .then((excludable) => {
            return excludable.map(excludable => [ excludable, `${ excludable }/**/*` ]);
        })
        .then((excludes) => {
            return Array.prototype.concat.apply([], excludes);
        });

        debug('in copyFiles', 'dependenciesExcludes', dependenciesExcludes);

        const ignore = [
            ...config.excludes,
            ...generalExcludes,
            ...dependenciesExcludes,
            ...[ config.output, `${ config.output }/**/*` ]
        ];

        debug('in copyFiles', 'ignore', ignore);

        const files = await globby(config.files, {
            cwd: this.dir,
            // TODO: https://github.com/isaacs/node-glob#options, warn for cyclic links.
            follow: true,
            mark: true,
            ignore,
        });

        debug('in copyFiles', 'config.files', config.files);
        debug('in copyFiles', 'files', files);

        if(config.packed) {

            switch(platform) {
            case 'win32':
            case 'win':
            case 'linux':
                const nwFile = await tmpName();
                await compress(this.dir, files, 'zip', nwFile);
                const executable = await findExecutable(platform, targetDir);
                await this.combineExecutable(executable, nwFile);
                await removeAsync(nwFile);
                break;
            case 'darwin':
            case 'osx':
            case 'mac':
                for(const file of files) {
                    await copyFileAsync(resolve(this.dir, file), resolve(appRoot, file));
                }
                break;
            default:
                throw new Error('ERROR_UNKNOWN_PLATFORM');
            }

        }
        else {

            for(const file of files) {
                await copyFileAsync(resolve(this.dir, file), resolve(appRoot, file));
            }

        }

        // Here we overwrite `package.json` with a stripped one.

        await writeFileAsync(resolve(appRoot, 'package.json'), (() => {

            const json: any = {};

            for(const key in pkg) {
                if(pkg.hasOwnProperty(key) && config.strippedProperties.indexOf(key) == -1) {
                    json[key] = pkg[key];
                }
            }

            return JSON.stringify(json);

        })());

    }

    protected async integrateFFmpeg(platform: string, arch: string, targetDir: string, pkg: any, config: BuildConfig) {

        const downloader = new FFmpegDownloader({
            platform, arch,
            version: config.nwVersion,
            useCaches: true,
            showProgress: this.options.mute ? false : true,
        });

        if(!this.options.mute) {
            console.info('Fetching FFmpeg prebuilt...', {
                platform: downloader.options.platform,
                arch: downloader.options.arch,
                version: downloader.options.version,
            });
        }

        const ffmpegDir = await downloader.fetchAndExtract();

        const src = await findFFmpeg(platform, ffmpegDir);
        const dest = await findFFmpeg(platform, targetDir);

        await copyAsync(src, dest);

    }

    protected async buildNsisDiffUpdater(platform: string, arch: string, versionInfo: NsisVersionInfo, fromVersion: string, toVersion: string, pkg: any, config: BuildConfig) {

        const diffNsis = resolve(this.dir, config.output, `${ pkg.name }-${ toVersion }-from-${ fromVersion }-${ platform }-${ arch }-Update.exe`);

        const fromDir = resolve(this.dir, config.output, (await versionInfo.getVersion(fromVersion)).source);
        const toDir = resolve(this.dir, config.output, (await versionInfo.getVersion(toVersion)).source);

        const data = await (new NsisDiffer(fromDir, toDir, {

            // Basic.
            appName: config.win.versionStrings.ProductName,
            companyName: config.win.versionStrings.CompanyName,
            description: config.win.versionStrings.FileDescription,
            version: fixWindowsVersion(config.win.productVersion),
            copyright: config.win.versionStrings.LegalCopyright,

            icon: config.nsis.icon ? resolve(this.dir, config.nsis.icon) : undefined,
            unIcon: config.nsis.unIcon ? resolve(this.dir, config.nsis.unIcon) : undefined,

            // Compression.
            compression: 'lzma',
            solid: true,

            languages: config.nsis.languages,

            // Output.
            output: diffNsis,

        })).make();

        const script = await tmpName();
        await writeFileAsync(script, data);

        await nsisBuild(toDir, script, {
            mute: this.options.mute,
        });

        await removeAsync(script);

        await versionInfo.addUpdater(toVersion, fromVersion, arch, diffNsis);

    }

    protected async buildDirTarget(platform: string, arch: string, runtimeDir: string, pkg: any, config: BuildConfig): Promise<string> {

        const targetDir = resolve(this.dir, config.output, `${ pkg.name }-${ pkg.version }-${ platform }-${ arch }`);
        const runtimeRoot = await findRuntimeRoot(platform, runtimeDir);
        const appRoot = resolve(targetDir, (() => {
            switch(platform) {
            case 'win32':
            case 'win':
            case 'linux':
                return './';
            case 'darwin':
            case 'osx':
            case 'mac':
                return './nwjs.app/Contents/Resources/app.nw/';
            default:
                throw new Error('ERROR_UNKNOWN_PLATFORM');
            }
        })());

        await new Promise((resolve, reject) => {
            emptyDir(targetDir, err => err ? reject(err) : resolve());
        });

        await copyAsync(runtimeRoot, targetDir, {
            //dereference: true,
        });

        if(config.ffmpegIntegration) {
            await this.integrateFFmpeg(platform, arch, targetDir, pkg, config);
        }

        await ensureDirAsync(appRoot);

        // Copy before refining might void the effort.

        switch(platform) {
        case 'win32':
        case 'win':
            await this.prepareWinBuild(targetDir, appRoot, pkg, config);
            await this.copyFiles(platform, targetDir, appRoot, pkg, config);
            await this.renameWinApp(targetDir, appRoot, pkg, config);
            break;
        case 'darwin':
        case 'osx':
        case 'mac':
            await this.prepareMacBuild(targetDir, appRoot, pkg, config);
            await this.copyFiles(platform, targetDir, appRoot, pkg, config);
            await this.renameMacApp(targetDir, appRoot, pkg, config);
            break;
        case 'linux':
            await this.prepareLinuxBuild(targetDir, appRoot, pkg, config);
            await this.copyFiles(platform, targetDir, appRoot, pkg, config);
            await this.renameLinuxApp(targetDir, appRoot, pkg, config);
            break;
        default:
            throw new Error('ERROR_UNKNOWN_PLATFORM');
        }

        return targetDir;

    }

    protected async buildArchiveTarget(type: string, sourceDir: string) {

        const targetArchive = resolve(dirname(sourceDir), `${ basename(sourceDir) }.${ type }`);

        await removeAsync(targetArchive);

        const files = await globby([ '**/*' ], {
            cwd: sourceDir,
        });

        await compress(sourceDir, files, type, targetArchive);

        return targetArchive;

    }

    protected async buildNsisTarget(platform: string, arch: string, sourceDir: string, pkg: any, config: BuildConfig) {

        if(platform != 'win') {
            if(!this.options.mute) {
                console.info(`Skip building nsis target for ${ platform }.`);
            }
            return;
        }

        const versionInfo = new NsisVersionInfo(resolve(this.dir, config.output, 'versions.nsis.json'));

        const targetNsis = resolve(dirname(sourceDir), `${ basename(sourceDir) }-Setup.exe`);

        const data = await (new NsisComposer({

            // Basic.
            appName: config.win.versionStrings.ProductName,
            companyName: config.win.versionStrings.CompanyName,
            description: config.win.versionStrings.FileDescription,
            version: fixWindowsVersion(config.win.productVersion),
            copyright: config.win.versionStrings.LegalCopyright,

            icon: config.nsis.icon ? resolve(this.dir, config.nsis.icon) : undefined,
            unIcon: config.nsis.unIcon ? resolve(this.dir, config.nsis.unIcon) : undefined,

            // Compression.
            compression: 'lzma',
            solid: true,

            languages: config.nsis.languages,

            // Output.
            output: targetNsis,

        })).make();

        const script = await tmpName();
        await writeFileAsync(script, data);

        await nsisBuild(sourceDir, script, {
            mute: this.options.mute,
        });

        await removeAsync(script);

        await versionInfo.addVersion(pkg.version, '', sourceDir);
        await versionInfo.addInstaller(pkg.version, arch, targetNsis);

        if(config.nsis.diffUpdaters) {

            for(const version of await versionInfo.getVersions()) {
                if(semver.gt(pkg.version, version)) {
                    await this.buildNsisDiffUpdater(platform, arch, versionInfo, version, pkg.version, pkg, config);
                }
            }

        }

        await versionInfo.save();

    }

    protected async buildNsis7zTarget(platform: string, arch: string, sourceDir: string, pkg: any, config: BuildConfig) {

        if(platform != 'win') {
            if(!this.options.mute) {
                console.info(`Skip building nsis7z target for ${ platform }.`);
            }
            return;
        }

        const sourceArchive = await this.buildArchiveTarget('7z', sourceDir);

        const versionInfo = new NsisVersionInfo(resolve(this.dir, config.output, 'versions.nsis.json'));

        const targetNsis = resolve(dirname(sourceDir), `${ basename(sourceDir) }-Setup.exe`);

        const data = await (new Nsis7Zipper(sourceArchive, {

            // Basic.
            appName: config.win.versionStrings.ProductName,
            companyName: config.win.versionStrings.CompanyName,
            description: config.win.versionStrings.FileDescription,
            version: fixWindowsVersion(config.win.productVersion),
            copyright: config.win.versionStrings.LegalCopyright,

            icon: config.nsis.icon ? resolve(this.dir, config.nsis.icon) : undefined,
            unIcon: config.nsis.unIcon ? resolve(this.dir, config.nsis.unIcon) : undefined,

            // Compression.
            compression: 'lzma',
            solid: true,

            languages: config.nsis.languages,

            // Output.
            output: targetNsis,

        })).make();

        const script = await tmpName();
        await writeFileAsync(script, data);

        await nsisBuild(sourceDir, script, {
            mute: this.options.mute,
        });

        await removeAsync(script);

        await versionInfo.addVersion(pkg.version, '', sourceDir);
        await versionInfo.addInstaller(pkg.version, arch, targetNsis);

        if(config.nsis.diffUpdaters) {

            for(const version of await versionInfo.getVersions()) {
                if(semver.gt(pkg.version, version)) {
                    await this.buildNsisDiffUpdater(platform, arch, versionInfo, version, pkg.version, pkg, config);
                }
            }

        }

        await versionInfo.save();

    }

    protected async buildTask(platform: string, arch: string, pkg: any, config: BuildConfig) {

        const downloader = new Downloader({
            platform, arch,
            version: config.nwVersion,
            flavor: config.nwFlavor,
            mirror: this.options.mirror,
            useCaches: true,
            showProgress: this.options.mute ? false : true,
        });

        if(!this.options.mute) {
            console.info('Fetching NW.js binary...', {
                platform: downloader.options.platform,
                arch: downloader.options.arch,
                version: downloader.options.version,
                flavor: downloader.options.flavor,
            });
        }

        const runtimeDir = await downloader.fetchAndExtract();

        if(!this.options.mute) {
            console.info('Building targets...');
        }

        const started = Date.now();

        const targetDir = await this.buildDirTarget(platform, arch, runtimeDir, pkg, config);

        if(!this.options.mute) {
            console.info(`Building directory target ends within ${ this.getTimeDiff(started) }ms.`);
        }

        // TODO: Consider using `Bluebird.map` to enable concurrent target building.
        for(const target of config.targets) {

            const started = Date.now();

            switch(target) {
            case 'zip':
            case '7z':
                await this.buildArchiveTarget(target, targetDir);
                if(!this.options.mute) {
                    console.info(`Building ${ target } archive target ends within ${ this.getTimeDiff(started) }ms.`);
                }
                break;
            case 'nsis':
                await this.buildNsisTarget(platform, arch, targetDir, pkg, config);
                if(!this.options.mute) {
                    console.info(`Building nsis target ends within ${ this.getTimeDiff(started) }ms.`);
                }
                break;
            case 'nsis7z':
                await this.buildNsis7zTarget(platform, arch, targetDir, pkg, config);
                if(!this.options.mute) {
                    console.info(`Building nsis7z target ends within ${ this.getTimeDiff(started) }ms.`);
                }
                break;
            default:
                throw new Error('ERROR_UNKNOWN_TARGET');
            }

        }

    }

}
