const { getConfig } = require('./lib/config')
const { isTriggerableReference } = require('./lib/triggerable-reference')
const {
  findReleases,
  generateReleaseInfo,
  createRelease,
  updateRelease,
} = require('./lib/releases')
const { findCommitsWithAssociatedPullRequests } = require('./lib/commits')
const { sortPullRequests } = require('./lib/sort-pull-requests')
const { log } = require('./lib/log')
const core = require('@actions/core')
const { runnerIsActions } = require('./lib/utils')
const ignore = require('ignore')

module.exports = (app, { getRouter }) => {
  if (!runnerIsActions() && typeof getRouter === 'function') {
    getRouter().get('/healthz', (request, response) => {
      response.status(200).json({ status: 'pass' })
    })
  }

  app.on(
    [
      'pull_request.opened',
      'pull_request.reopened',
      'pull_request.synchronize',
      'pull_request.edited',
      // 'pull_request_target.opened',
      // 'pull_request_target.reopened',
      // 'pull_request_target.synchronize',
      // 'pull_request_target.edited',
    ],
    async (context) => {
      const { configName, disableAutolabeler } = getInput()

      const config = await getConfig({
        context,
        configName,
      })

      if (config === null || disableAutolabeler) return

      let issue = {
        ...context.issue({ pull_number: context.payload.pull_request.number }),
      }
      const changedFiles = await context.octokit.paginate(
        context.octokit.pulls.listFiles.endpoint.merge(issue),
        (response) => response.data.map((file) => file.filename)
      )
      const labels = new Set()

      for (const autolabel of config['autolabeler']) {
        let found = false
        // check modified files
        if (!found && autolabel.files.length > 0) {
          const matcher = ignore().add(autolabel.files)
          if (changedFiles.some((file) => matcher.ignores(file))) {
            labels.add(autolabel.label)
            found = true
            log({
              context,
              message: `Found label for files: '${autolabel.label}'`,
            })
          }
        }
        // check branch names
        if (!found && autolabel.branch.length > 0) {
          for (const matcher of autolabel.branch) {
            if (matcher.test(context.payload.pull_request.head.ref)) {
              labels.add(autolabel.label)
              found = true
              log({
                context,
                message: `Found label for branch: '${autolabel.label}'`,
              })
              break
            }
          }
        }
        // check pr title
        if (!found && autolabel.title.length > 0) {
          for (const matcher of autolabel.title) {
            if (matcher.test(context.payload.pull_request.title)) {
              labels.add(autolabel.label)
              found = true
              log({
                context,
                message: `Found label for title: '${autolabel.label}'`,
              })
              break
            }
          }
        }
        // check pr body
        if (
          !found &&
          context.payload.pull_request.body != null &&
          autolabel.body.length > 0
        ) {
          for (const matcher of autolabel.body) {
            if (matcher.test(context.payload.pull_request.body)) {
              labels.add(autolabel.label)
              found = true
              log({
                context,
                message: `Found label for body: '${autolabel.label}'`,
              })
              break
            }
          }
        }
      }

      const labelsToAdd = [...labels]
      if (labelsToAdd.length > 0) {
        let labelIssue = {
          ...context.issue({
            issue_number: context.payload.pull_request.number,
            labels: labelsToAdd,
          }),
        }
        await context.octokit.issues.addLabels(labelIssue)
        if (runnerIsActions()) {
          core.setOutput('number', context.payload.pull_request.number)
          core.setOutput('labels', labelsToAdd.join(','))
        }
        return
      }
    }
  )

  const drafter = async (context) => {
    const input = getInput()

    const config = await getConfig({
      context,
      configName: input.configName,
    })

    if (!config || input.disableReleaser) return

    updateConfigFromInput(config, input)

    const ref = process.env['GITHUB_REF'] || context.payload.ref

    if (!isTriggerableReference({ ref, context, config })) {
      return
    }

    // --- START NEW LOGIC: Find associated PR for push events ---
    let prNumber = null
    if (
      context.name === 'push' &&
      context.payload.head_commit &&
      !context.payload.deleted
    ) {
      const { owner, repo } = context.repo()
      const commitSha = context.payload.after // 'after' is the SHA of the most recent commit on ref after the push
      try {
        const associatedPulls =
          await context.octokit.repos.listPullRequestsAssociatedWithCommit({
            owner,
            repo,
            commit_sha: commitSha,
          })

        // Find the first open PR targeting one of the configured branches
        const targetBranches = config.references.map((r) =>
          r.replace(/^refs\/heads\//, '')
        )
        const relevantPR = associatedPulls.data.find(
          (pr) => pr.state === 'open' && targetBranches.includes(pr.base.ref)
        )

        if (relevantPR) {
          prNumber = relevantPR.number
          log({
            context,
            message: `Push is associated with open PR #${prNumber}`,
          })
        } else {
          log({
            context,
            message: `Push commit ${commitSha.slice(
              0,
              7
            )} is not associated with an open PR targeting ${targetBranches.join(
              '/'
            )}`,
          })
        }
      } catch (error) {
        log({
          context,
          error,
          message: `Could not list PRs for commit ${commitSha.slice(0, 7)}`,
        })
        // Continue without PR context if lookup fails
      }
    } else if (context.name.startsWith('pull_request')) {
      // If triggered by pull_request event directly (though drafter is usually on push/any)
      prNumber = context.payload.pull_request?.number
      if (prNumber) {
        log({ context, message: `Event is for PR #${prNumber}` })
      }
    }
    // --- END NEW LOGIC ---

    // GitHub Actions merge payloads slightly differ... (existing logic)
    // const ref = process.env['GITHUB_REF'] || context.payload.ref; // Already defined above

    // if (!isTriggerableReference({ ref, context, config })) { // Already checked above
    //   return;
    // }

    const targetCommitish = config.commitish || ref // Use determined ref

    const {
      'filter-by-commitish': filterByCommitish,
      'include-pre-releases': includePreReleases, // Keep this for finding general drafts initially
      'prerelease-identifier': preReleaseIdentifier,
      'tag-prefix': tagPrefix,
      latest, // from input/config
      prerelease, // from input/config
    } = config

    // Determine if *this specific run* should be treated as a prerelease based on config/input
    const isEffectivePreRelease = Boolean(
      prerelease === undefined ? prerelease : prerelease
    )
    const usePrereleaseIdentifier =
      isEffectivePreRelease && preReleaseIdentifier

    // We still need to consider `includePreReleases` for finding the `lastRelease`,
    // but the *draft* we look for/create depends on `isEffectivePreRelease`.
    const shouldIncludePreReleasesForLast = Boolean(
      includePreReleases || usePrereleaseIdentifier // Include prereleases in history if identifier is set
    )

    const { draftRelease, lastRelease } = await findReleases({
      context,
      targetCommitish: targetCommitish, // Use potentially modified targetCommitish
      filterByCommitish,
      includePreReleases: shouldIncludePreReleasesForLast,
      tagPrefix,
      // Pass the effective prerelease status for *this run* to potentially filter drafts
      // Note: findReleases currently only filters draft by includePreReleases,
      // we will do PR-specific filtering later.
      // isEffectivePreRelease: isEffectivePreRelease
    })

    const { commits, pullRequests: mergedPullRequests } =
      await findCommitsWithAssociatedPullRequests({
        context,
        targetCommitish: targetCommitish, // Use potentially modified targetCommitish
        lastRelease,
        config,
      })

    const sortedMergedPullRequests = sortPullRequests(
      mergedPullRequests,
      config['sort-by'],
      config['sort-direction']
    )

    const { shouldDraft, version, tag, name } = input // Get overrides from input

    // **MODIFIED CALL:** Pass prNumber and draftRelease
    const releaseInfo = generateReleaseInfo({
      context,
      commits,
      config,
      lastRelease,
      mergedPullRequests: sortedMergedPullRequests,
      version, // from input
      tag, // from input
      name, // from input
      // Use the effective prerelease status for *this* release generation:
      isPreRelease: isEffectivePreRelease,
      latest, // from input/config
      shouldDraft, // from input
      targetCommitish: targetCommitish, // Pass the final targetCommitish
      // --- Pass new arguments ---
      prNumber,
      draftRelease, // Pass the potentially found draft
      // --- End new arguments ---
    })

    // Check if releaseInfo is null (could happen if version calc failed)
    if (!releaseInfo) {
      log({
        context,
        message:
          'Failed to generate release info. Skipping release creation/update.',
      })
      // Optionally set action failure
      // core.setFailed("Failed to generate release info.");
      return
    }

    let createOrUpdateReleaseResponse
    // **MODIFIED LOGIC:** Decide update based on PR-specific draft existence passed back in releaseInfo
    if (!releaseInfo.foundPrSpecificDraft) {
      // Check a flag we'll set in generateReleaseInfo
      log({ context, message: 'Creating new release' })
      createOrUpdateReleaseResponse = await createRelease({
        context,
        releaseInfo,
        config, // config might not be needed here anymore? Check createRelease
      })
    } else {
      log({
        context,
        message: `Updating existing PR-specific draft release for PR #${prNumber}`,
      })
      createOrUpdateReleaseResponse = await updateRelease({
        context,
        draftRelease: draftRelease, // Use the original draftRelease object found earlier
        releaseInfo,
        config, // config might not be needed here anymore? Check updateRelease
      })
    }

    if (runnerIsActions()) {
      setActionOutput(createOrUpdateReleaseResponse, releaseInfo)
    }
  }

  if (runnerIsActions()) {
    app.onAny(drafter)
  } else {
    app.on('push', drafter)
  }
}

function getInput() {
  return {
    configName: core.getInput('config-name'),
    shouldDraft: core.getInput('publish').toLowerCase() !== 'true',
    version: core.getInput('version') || undefined,
    tag: core.getInput('tag') || undefined,
    name: core.getInput('name') || undefined,
    disableReleaser: core.getInput('disable-releaser').toLowerCase() === 'true',
    disableAutolabeler:
      core.getInput('disable-autolabeler').toLowerCase() === 'true',
    commitish: core.getInput('commitish') || undefined,
    header: core.getInput('header') || undefined,
    footer: core.getInput('footer') || undefined,
    prerelease:
      core.getInput('prerelease') !== ''
        ? core.getInput('prerelease').toLowerCase() === 'true'
        : undefined,
    preReleaseIdentifier: core.getInput('prerelease-identifier') || undefined,
    latest: core.getInput('latest')?.toLowerCase() || undefined,
  }
}

/**
 * Merges the config file with the input
 * the input takes precedence, because it's more easy to change at runtime
 */
function updateConfigFromInput(config, input) {
  if (input.commitish) {
    config.commitish = input.commitish
  }

  if (input.header) {
    config.header = input.header
  }

  if (input.footer) {
    config.footer = input.footer
  }

  if (input.prerelease !== undefined) {
    config.prerelease = input.prerelease
  }

  if (input.preReleaseIdentifier) {
    config['prerelease-identifier'] = input.preReleaseIdentifier
  }

  config.latest = config.prerelease
    ? 'false'
    : input.latest || config.latest || undefined
}

function setActionOutput(
  releaseResponse,
  { body, resolvedVersion, majorVersion, minorVersion, patchVersion }
) {
  const {
    data: {
      id: releaseId,
      html_url: htmlUrl,
      upload_url: uploadUrl,
      tag_name: tagName,
      name: name,
    },
  } = releaseResponse
  if (releaseId && Number.isInteger(releaseId))
    core.setOutput('id', releaseId.toString())
  if (htmlUrl) core.setOutput('html_url', htmlUrl)
  if (uploadUrl) core.setOutput('upload_url', uploadUrl)
  if (tagName) core.setOutput('tag_name', tagName)
  if (name) core.setOutput('name', name)
  if (resolvedVersion) core.setOutput('resolved_version', resolvedVersion)
  if (majorVersion) core.setOutput('major_version', majorVersion)
  if (minorVersion) core.setOutput('minor_version', minorVersion)
  if (patchVersion) core.setOutput('patch_version', patchVersion)
  core.setOutput('body', body)
}
