import path from "path";
import fs from "fs-extra";
import detectIndent from "detect-indent";
import semver from "semver";

import * as boltMessages from "bolt/dist/modern/utils/messages";

import getWorkspaces from "../../utils/getWorkspaces";
import getDependencyGraph from "get-dependency-graph";

import logger from "../../utils/logger";
import * as git from "@changesets/git";
import createRelease from "../../utils/createRelease";
import createReleaseCommit from "./createReleaseCommit";
import { removeFolders, removeEmptyFolders } from "../../utils/removeFolders";
import updateChangelog from "../../utils/updateChangelog";
import getReleaseInfo from "@changesets/get-release-info";

import resolveConfig from "../../utils/resolveConfig";
import getChangesetBase from "../../utils/getChangesetBase";
import {
  getDependencyVersionRange,
  getDependencyTypes
} from "../../utils/bolt-replacements/getDependencyInfo";
import versionRangeToRangeType from "../../utils/bolt-replacements/versionRangeToRangeType";
import { defaultConfig } from "../../utils/constants";

export default async function version(opts) {
  let userConfig = await resolveConfig(opts.cwd);

  userConfig =
    userConfig && userConfig.versionOptions ? userConfig.versionOptions : {};
  const config = { ...defaultConfig.versionOptions, ...userConfig, ...opts };

  const cwd = config.cwd || process.cwd();

  const allPackages = await getWorkspaces({ cwd });
  const changesetBase = await getChangesetBase(cwd);

  removeEmptyFolders(changesetBase);

  // 1 get old changesets
  // 2 get new changesets + dependents

  const unreleasedChangesets = await getReleaseInfo(cwd);

  if (unreleasedChangesets.length === 0) {
    logger.warn("No unreleased changesets found, exiting.");
    return;
  }

  const releaseObj = createRelease(
    unreleasedChangesets,
    allPackages,
    config.linked
  );
  const publishCommit = createReleaseCommit(releaseObj, config.skipCI);

  logger.log(publishCommit);

  await bumpReleasedPackages(releaseObj, allPackages, config);

  if (config.updateChangelog) {
    logger.log("Updating changelogs...");
    // Now update the changelogs
    const changelogPaths = await updateChangelog(releaseObj, config);
    if (config.commit) {
      for (const changelogPath of changelogPaths) {
        await git.add(changelogPath, cwd);
      }
    }
  }

  logger.log("Removing changesets...");

  // This should then reset the changesets folder to a blank state
  removeFolders(changesetBase);
  // Remove files
  if (config.commit) {
    await git.add(changesetBase, cwd);

    logger.log("Committing changes...");
    // TODO: Check if there are any unstaged changed before committing and throw
    // , as it means something went super-odd.
    await git.commit(publishCommit, cwd);
  } else {
    logger.log(
      "All files have been updated. Review them and commit at your leisure"
    );
    logger.warn(
      "If you alter version changes in package.jsons, make sure to run bolt before publishing to ensure the repo is in a valid state"
    );
  }
}

async function bumpReleasedPackages(releaseObj, allPackages, config) {
  const versionsToUpdate = releaseObj.releases.reduce(
    (cur, next) => ({
      ...cur,
      [next.name]: next.version
    }),
    {}
  );

  const { graph } = await getDependencyGraph(allPackages, config.cwd);
  const internalDeps = Object.keys(versionsToUpdate).filter(dep =>
    graph.has(dep)
  );
  const externalDeps = Object.keys(versionsToUpdate).filter(
    dep => !graph.has(dep)
  );

  if (externalDeps.length !== 0) {
    logger.warn(
      boltMessages.externalDepsPassedToUpdatePackageVersions(externalDeps)
    );
  }

  // for each package, even non-released ones we:
  // Check if all its things are still in semver
  // IF they are not AND it's not being released, collect an error about it
  // If the package is being released, modify its

  for (const pkg of allPackages) {
    const newPkgJSON = { ...pkg.config };
    const inUpdatedPackages = internalDeps.includes(pkg.name);

    for (const depName of internalDeps) {
      const depRange = String(getDependencyVersionRange(depName, pkg.config));
      const depTypes = getDependencyTypes(depName, pkg.config);
      const rangeType = versionRangeToRangeType(depRange);
      const newDepRange = rangeType + versionsToUpdate[depName];
      if (depTypes.length === 0) continue;

      const willLeaveSemverRange = !semver.satisfies(
        versionsToUpdate[depName],
        depRange
      );
      // This check determines whether the package will be released. If the
      // package will not be released, we throw.
      if (!inUpdatedPackages && willLeaveSemverRange) {
        throw new Error(
          boltMessages.invalidBoltWorkspacesFromUpdate(
            pkg.name,
            depName,
            depRange,
            internalDeps[depName]
          )
        );
      }

      for (const depType of depTypes) {
        newPkgJSON[depType][depName] = newDepRange;
      }
    }

    if (!inUpdatedPackages) continue;

    const pkgDir = pkg.dir;
    const pkgJsonPath = path.join(pkgDir, "package.json");
    const pkgJsonRaw = await fs.readFile(pkgJsonPath, "utf-8");
    const indent = detectIndent(pkgJsonRaw).indent || "  ";

    newPkgJSON.version = versionsToUpdate[pkg.name];

    const pkgJsonStr = JSON.stringify(newPkgJSON, null, indent);
    await fs.writeFile(pkgJsonPath, pkgJsonStr);
    if (config.commit) {
      await git.add(pkgJsonPath, config.cwd);
    }
  }
}