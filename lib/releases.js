const compareVersions = require('compare-versions')
const regexEscape = require('escape-string-regexp')
const core = require('@actions/core')
const semver = require('semver') // Ensure semver is required

const { getVersionInfo } = require('./versions')
const { template } = require('./template')
const { log } = require('./log')

const sortReleases = (releases, tagPrefix) => {
  // For semver, we find the greatest release number
  // For non-semver, we use the most recently merged
  const tagPrefixRexExp = new RegExp(`^${regexEscape(tagPrefix)}`)
  return releases.sort((r1, r2) => {
    try {
      return compareVersions(
        r1.tag_name.replace(tagPrefixRexExp, ''),
        r2.tag_name.replace(tagPrefixRexExp, '')
      )
    } catch {
      return new Date(r1.created_at) - new Date(r2.created_at)
    }
  })
}

// GitHub API currently returns a 500 HTTP response if you attempt to fetch over 1000 releases.
const RELEASE_COUNT_LIMIT = 1000

const findReleases = async ({
  context,
  targetCommitish,
  filterByCommitish,
  includePreReleases,
  tagPrefix,
  prNumber,
  isPrereleaseRun, // Boolean indicating if we should search for PR-specific release
}) => {
  let releaseCount = 0
  let releases = await context.octokit.paginate(
    context.octokit.repos.listReleases.endpoint.merge(
      context.repo({
        per_page: 100,
      })
    ),
    (response, done) => {
      releaseCount += response.data.length
      if (releaseCount >= RELEASE_COUNT_LIMIT) {
        done()
      }
      return response.data
    }
  )

  log({ context, message: `Found ${releases.length} releases` })

  // `refs/heads/branch` and `branch` are the same thing in this context
  const headRefRegex = /^refs\/heads\//
  const targetCommitishName = targetCommitish.replace(headRefRegex, '')
  const commitishFilteredReleases = filterByCommitish
    ? releases.filter(
        (r) =>
          targetCommitishName === r.target_commitish.replace(headRefRegex, '')
      )
    : releases
  const prefixFilteredReleases = tagPrefix
    ? commitishFilteredReleases.filter((r) => r.tag_name.startsWith(tagPrefix))
    : commitishFilteredReleases
  const sortedSelectedReleases = sortReleases(prefixFilteredReleases, tagPrefix)
  const lastReleaseFilter = sortedSelectedReleases.filter(
    (r) => !r.draft && (!r.prerelease || includePreReleases)
  )
  const lastRelease = lastReleaseFilter[lastReleaseFilter.length - 1]

  let prSpecificRelease = null
  if (isPrereleaseRun && sortedSelectedReleases.length > 0) {
    const sortedCandidateReleases = sortedSelectedReleases.filter((r) => {
      const bodyMatch = r.body?.match(PR_MARKER_REGEX)
      return !(!bodyMatch || Number.parseInt(bodyMatch[1], 10) !== prNumber)
    })

    log({
      context,
      message: `Found ${sortedCandidateReleases.length} candidate releases matching PR #${prNumber}.`,
    })

    prSpecificRelease =
      sortedCandidateReleases[sortedCandidateReleases.length - 1]
  }

  if (!prSpecificRelease) {
    log({
      context,
      message: `No existing release found matching PR #${prNumber} and format.`,
    })
  }

  return {
    prSpecificRelease,
    lastRelease,
  }
}

const contributorsSentence = ({ commits, pullRequests, config }) => {
  const { 'exclude-contributors': excludeContributors } = config

  const contributors = new Set()

  for (const commit of commits) {
    if (commit.author.user) {
      if (!excludeContributors.includes(commit.author.user.login)) {
        contributors.add(`@${commit.author.user.login}`)
      }
    } else {
      contributors.add(commit.author.name)
    }
  }

  for (const pullRequest of pullRequests) {
    if (
      pullRequest.author &&
      !excludeContributors.includes(pullRequest.author.login)
    ) {
      if (pullRequest.author.__typename === 'Bot') {
        contributors.add(
          `[${pullRequest.author.login}[bot]](${pullRequest.author.url})`
        )
      } else {
        contributors.add(`@${pullRequest.author.login}`)
      }
    }
  }

  const sortedContributors = [...contributors].sort()
  if (sortedContributors.length > 1) {
    return (
      sortedContributors.slice(0, -1).join(', ') +
      ' and ' +
      sortedContributors.slice(-1)
    )
  } else if (sortedContributors.length === 1) {
    return sortedContributors[0]
  } else {
    return config['no-contributors-template']
  }
}

const getFilterExcludedPullRequests = (excludeLabels) => {
  return (pullRequest) => {
    const labels = pullRequest.labels.nodes
    if (labels.some((label) => excludeLabels.includes(label.name))) {
      return false
    }
    return true
  }
}

const getFilterIncludedPullRequests = (includeLabels) => {
  return (pullRequest) => {
    const labels = pullRequest.labels.nodes
    if (
      includeLabels.length === 0 ||
      labels.some((label) => includeLabels.includes(label.name))
    ) {
      return true
    }
    return false
  }
}

const categorizePullRequests = (pullRequests, config) => {
  const {
    'exclude-labels': excludeLabels,
    'include-labels': includeLabels,
    categories,
  } = config
  const allCategoryLabels = new Set(
    categories.flatMap((category) => category.labels)
  )
  const uncategorizedPullRequests = []
  const categorizedPullRequests = [...categories].map((category) => {
    return { ...category, pullRequests: [] }
  })

  const uncategorizedCategoryIndex = categories.findIndex(
    (category) => category.labels.length === 0
  )

  const filterUncategorizedPullRequests = (pullRequest) => {
    const labels = pullRequest.labels.nodes

    if (
      labels.length === 0 ||
      !labels.some((label) => allCategoryLabels.has(label.name))
    ) {
      if (uncategorizedCategoryIndex === -1) {
        uncategorizedPullRequests.push(pullRequest)
      } else {
        categorizedPullRequests[uncategorizedCategoryIndex].pullRequests.push(
          pullRequest
        )
      }
      return false
    }
    return true
  }

  // we only want pull requests that have yet to be categorized
  const filteredPullRequests = pullRequests
    .filter(getFilterExcludedPullRequests(excludeLabels))
    .filter(getFilterIncludedPullRequests(includeLabels))
    .filter((pullRequest) => filterUncategorizedPullRequests(pullRequest))

  for (const category of categorizedPullRequests) {
    for (const pullRequest of filteredPullRequests) {
      // lets categorize some pull request based on labels
      // note that having the same label in multiple categories
      // then it is intended to "duplicate" the pull request into each category
      const labels = pullRequest.labels.nodes
      if (labels.some((label) => category.labels.includes(label.name))) {
        category.pullRequests.push(pullRequest)
      }
    }
  }

  return [uncategorizedPullRequests, categorizedPullRequests]
}

const generateChangeLog = (mergedPullRequests, config) => {
  if (mergedPullRequests.length === 0) {
    return config['no-changes-template']
  }

  const [uncategorizedPullRequests, categorizedPullRequests] =
    categorizePullRequests(mergedPullRequests, config)

  const escapeTitle = (title) =>
    // If config['change-title-escapes'] contains backticks, then they will be escaped along with content contained inside backticks
    // If not, the entire backtick block is matched so that it will become a markdown code block without escaping any of its content
    title.replace(
      new RegExp(
        `[${regexEscape(config['change-title-escapes'])}]|\`.*?\``,
        'g'
      ),
      (match) => {
        if (match.length > 1) return match
        if (match == '@' || match == '#') return `${match}<!---->`
        return `\\${match}`
      }
    )

  const pullRequestToString = (pullRequests) =>
    pullRequests
      .map((pullRequest) => {
        var pullAuthor = 'ghost'
        if (pullRequest.author) {
          pullAuthor =
            pullRequest.author.__typename &&
            pullRequest.author.__typename === 'Bot'
              ? `[${pullRequest.author.login}[bot]](${pullRequest.author.url})`
              : pullRequest.author.login
        }

        return template(config['change-template'], {
          $TITLE: escapeTitle(pullRequest.title),
          $NUMBER: pullRequest.number,
          $AUTHOR: pullAuthor,
          $BODY: pullRequest.body,
          $URL: pullRequest.url,
          $BASE_REF_NAME: pullRequest.baseRefName,
          $HEAD_REF_NAME: pullRequest.headRefName,
        })
      })
      .join('\n')

  const changeLog = []

  if (uncategorizedPullRequests.length > 0) {
    changeLog.push(pullRequestToString(uncategorizedPullRequests), '\n\n')
  }

  for (const [index, category] of categorizedPullRequests.entries()) {
    if (category.pullRequests.length === 0) {
      continue
    }

    // Add the category title to the changelog.
    changeLog.push(
      template(config['category-template'], { $TITLE: category.title }),
      '\n\n'
    )

    // Define the pull requests into a single string.
    const pullRequestString = pullRequestToString(category.pullRequests)

    // Determine the collapse status.
    const shouldCollapse =
      category['collapse-after'] !== 0 &&
      category.pullRequests.length > category['collapse-after']

    // Add the pull requests to the changelog.
    if (shouldCollapse) {
      changeLog.push(
        '<details>',
        '\n',
        `<summary>${category.pullRequests.length} changes</summary>`,
        '\n\n',
        pullRequestString,
        '\n',
        '</details>'
      )
    } else {
      changeLog.push(pullRequestString)
    }

    if (index + 1 !== categorizedPullRequests.length) changeLog.push('\n\n')
  }

  return changeLog.join('').trim()
}

const resolveVersionKeyIncrement = (
  mergedPullRequests,
  config,
  isPreRelease
) => {
  const priorityMap = {
    patch: 1,
    minor: 2,
    major: 3,
  }

  const labelToKeyMap = Object.fromEntries(
    Object.keys(priorityMap)
      .flatMap((key) => [
        config['version-resolver'][key].labels.map((label) => [label, key]),
      ])
      .flat()
  )

  core.debug('labelToKeyMap: ' + JSON.stringify(labelToKeyMap))

  const keys = mergedPullRequests
    .filter(getFilterExcludedPullRequests(config['exclude-labels']))
    .filter(getFilterIncludedPullRequests(config['include-labels']))
    .flatMap((pr) => pr.labels.nodes.map((node) => labelToKeyMap[node.name]))
    .filter(Boolean)

  core.debug('keys: ' + JSON.stringify(keys))

  const keyPriorities = keys.map((key) => priorityMap[key])
  const priority = Math.max(...keyPriorities)
  const versionKey = Object.keys(priorityMap).find(
    (key) => priorityMap[key] === priority
  )

  core.debug('versionKey: ' + versionKey)

  const versionKeyIncrement = versionKey || config['version-resolver'].default

  const shouldIncrementAsPrerelease =
    isPreRelease && config['prerelease-identifier']

  if (!shouldIncrementAsPrerelease) {
    return versionKeyIncrement
  }

  return `pre${versionKeyIncrement}`
}

const PR_MARKER_REGEX = /<!-- pr-number: (\d+) -->/

const generateReleaseInfo = ({
  context,
  commits,
  config,
  lastRelease,
  mergedPullRequests,
  version, // explicit version override from input
  tag, // explicit tag override from input
  name, // explicit name override from input
  isPreRelease, // whether *this run* should create/update a prerelease
  latest,
  shouldDraft,
  targetCommitish,
  prNumber,
  prSpecificRelease,
}) => {
  const { owner, repo } = context.repo()

  const {
    'prerelease-identifier': preReleaseIdentifier,
    'tag-prefix': tagPrefix,
    'version-template': versionTemplate,
    'tag-template': tagTemplate,
    'name-template': nameTemplate,
    replacers,
  } = config

  let versionInfo = null
  let resolvedVersion
  let majorVersion, minorVersion, patchVersion
  let calculatedTag = tag // Use explicit tag if provided, otherwise calculate
  let calculatedName = name // Use explicit name if provided, otherwise calculate
  let body = ''
  let prSpecificDraftExists = false
  let markerAdded = false

  // --- START PR-SPECIFIC PRE-RELEASE LOGIC ---
  const isPrereleaseRun =
    isPreRelease && preReleaseIdentifier && prNumber !== null

  if (isPrereleaseRun && prSpecificRelease) {
    prSpecificDraftExists = true
    log({
      context,
      message: `Found existing draft release (${prSpecificRelease.tag_name}) for PR #${prNumber}. Incrementing suffix.`,
    })

    try {
      const currentTag = prSpecificRelease.tag_name
      const currentVersionStr =
        tagPrefix && currentTag.startsWith(tagPrefix)
          ? currentTag.slice(tagPrefix.length)
          : currentTag
      const parsedVersion = semver.parse(currentVersionStr)
      if (
        parsedVersion &&
        parsedVersion.prerelease?.length >= 2 &&
        parsedVersion.prerelease[0] === preReleaseIdentifier
      ) {
        const currentSuffix = parsedVersion.prerelease[1]
        if (typeof currentSuffix === 'number') {
          const nextSuffix = currentSuffix + 1
          // Reconstruct version with incremented suffix
          resolvedVersion = `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}-${preReleaseIdentifier}.${nextSuffix}`
          majorVersion = parsedVersion.major
          minorVersion = parsedVersion.minor
          patchVersion = parsedVersion.patch

          const versionKeyIncrement = resolveVersionKeyIncrement(
            mergedPullRequests,
            config,
            isPreRelease
          )
          // Use the raw resolvedVersion for template inputs initially
          const versionInfo = getVersionInfo(
            prSpecificRelease,
            config['version-template'],
            version || tag || name,
            versionKeyIncrement,
            config['tag-prefix'],
            config['prerelease-identifier']
          )

          // const simpleVersionInfo = {
          //   version: resolvedVersion,
          //   $MAJOR: majorVersion,
          //   $MINOR: minorVersion,
          //   $PATCH: patchVersion,
          //   $PRERELEASE: `-${preReleaseIdentifier}.${nextSuffix}`, // Construct prerelease part
          //   $COMPLETE: resolvedVersion,
          // }

          // Recalculate tag and name based *only* on the incremented version if not explicitly provided
          if (calculatedTag === undefined) {
            calculatedTag = template(tagTemplate || '', versionInfo)
            if (tagPrefix && !calculatedTag.startsWith(tagPrefix)) {
              calculatedTag = tagPrefix + calculatedTag
            }
          } else {
            // template explicit tag with new version info
            calculatedTag = template(calculatedTag, versionInfo)
          }

          // eslint-disable-next-line unicorn/prefer-ternary
          if (calculatedName === undefined) {
            calculatedName = template(nameTemplate || '', versionInfo)
          } else {
            // template explicit name with new version info
            calculatedName = template(calculatedName, versionInfo)
          }

          log({
            context,
            message: `Incremented prerelease version for PR #${prNumber} to: ${resolvedVersion} (Tag: ${calculatedTag})`,
          })
          // Prevent standard version calculation below
          // versionInfo = versionInfo // Use the minimal info we derived
        }
      }
    } catch (error) {
      log({
        context,
        error,
        message: `Error processing draft tag ${prSpecificRelease.tag_name}. Falling back to standard versioning.`,
      })
      prSpecificDraftExists = false // Treat as if no draft found
    }
  }
  // --- END PR-SPECIFIC PRE-RELEASE LOGIC ---

  // --- Standard Version Calculation (if not overridden above) ---
  if (versionInfo === null) {
    const versionKeyIncrement = resolveVersionKeyIncrement(
      mergedPullRequests,
      config,
      isPreRelease
    )
    core.debug('versionKeyIncrement: ' + versionKeyIncrement)

    // Get base version info based on lastRelease and increment type
    versionInfo = getVersionInfo(
      lastRelease,
      versionTemplate,
      version || tag || name, // Use explicit override if available
      versionKeyIncrement,
      tagPrefix,
      preReleaseIdentifier // Pass identifier for potential initial prerelease suffix
    )
    core.debug(
      'versionInfo (standard calc): ' + JSON.stringify(versionInfo, null, 2)
    )

    if (!versionInfo || !versionInfo.$RESOLVED_VERSION) {
      log({
        context,
        error: new Error('Version calculation failed'),
        message: 'Could not resolve version.',
      })
      return null // Stop processing if version is unresolvable
    }

    resolvedVersion = versionInfo.$RESOLVED_VERSION.version
    majorVersion = versionInfo.$RESOLVED_VERSION.$MAJOR
    minorVersion = versionInfo.$RESOLVED_VERSION.$MINOR
    patchVersion = versionInfo.$RESOLVED_VERSION.$PATCH

    // --- Handle initial PR prerelease version (.0 suffix) ---
    if (isPrereleaseRun && !prSpecificDraftExists) {
      const baseVersion = `${majorVersion}.${minorVersion}.${patchVersion}`
      resolvedVersion = `${baseVersion}-${preReleaseIdentifier}.0`
      log({
        context,
        message: `First prerelease for PR #${prNumber}. Setting version to: ${resolvedVersion}`,
      })

      // Update versionInfo for templating tag/name/body
      versionInfo.$RESOLVED_VERSION.version = resolvedVersion
      versionInfo.$RESOLVED_VERSION.$PRERELEASE = `-${preReleaseIdentifier}.0`
      versionInfo.$RESOLVED_VERSION.$COMPLETE = resolvedVersion
      // Adjust other $NEXT_ versions if necessary, though likely less relevant for PR prereleases

      // Add the marker to be included in the body later
      body += `\n\n<!-- pr-number: ${prNumber} -->\n`
      markerAdded = true
    }
    // --- End initial PR prerelease version ---

    // Calculate tag and name using the potentially adjusted versionInfo
    if (calculatedTag === undefined) {
      calculatedTag = template(tagTemplate || '', versionInfo)
      if (tagPrefix && !calculatedTag.startsWith(tagPrefix)) {
        calculatedTag = tagPrefix + calculatedTag
      }
    } else {
      calculatedTag = template(calculatedTag, versionInfo) // template explicit tag
    }

    // eslint-disable-next-line unicorn/prefer-ternary
    if (calculatedName === undefined) {
      calculatedName = template(nameTemplate || '', versionInfo)
    } else {
      calculatedName = template(calculatedName, versionInfo) // template explicit name
    }
  }
  // --- End Standard Version Calculation ---

  // Append the PR marker if it wasn't added during initial version creation
  if (isPrereleaseRun && !markerAdded) {
    body += `\n\n<!-- pr-number: ${prNumber} -->\n`
  }

  let generatedBody = config['header'] + config.template + config['footer']
  generatedBody = template(
    generatedBody,
    {
      $PREVIOUS_TAG: lastRelease ? lastRelease.tag_name : '',
      $CHANGES: generateChangeLog(mergedPullRequests, config),
      $CONTRIBUTORS: contributorsSentence({
        commits,
        pullRequests: mergedPullRequests,
        config,
      }),
      $OWNER: owner,
      $REPOSITORY: repo,
      ...versionInfo,
    },
    replacers
  )
  // Prepend the generated body content
  body = generatedBody + body
  // --- End Generate Body ---

  core.debug('Final tag: ' + calculatedTag)
  core.debug('Final name: ' + calculatedName)
  // Debug final body, careful with large bodies
  // core.debug('Final body: ' + body.substring(0, 200) + '...');

  // --- Final cleanup of targetCommitish ---
  if (targetCommitish.startsWith('refs/tags/')) {
    log({
      context,
      message: `${targetCommitish} is not supported as release target, falling back to default branch`,
    })
    targetCommitish = '' // Reset to let GitHub API use default branch
  }

  return {
    name: calculatedName,
    tag: calculatedTag,
    body: body.trim(), // Trim whitespace from body
    targetCommitish,
    prerelease: isPreRelease, // Use the effective prerelease status for this run
    make_latest: latest, // Use resolved latest flag
    draft: shouldDraft,
    resolvedVersion,
    majorVersion,
    minorVersion,
    patchVersion,
    foundPrSpecificDraft: prSpecificDraftExists, // Signal whether update is needed
  }
}

const createRelease = ({ context, releaseInfo }) => {
  return context.octokit.repos.createRelease(
    context.repo({
      target_commitish: releaseInfo.targetCommitish,
      name: releaseInfo.name,
      tag_name: releaseInfo.tag,
      body: releaseInfo.body,
      draft: releaseInfo.draft,
      prerelease: releaseInfo.prerelease,
      make_latest: releaseInfo.make_latest,
    })
  )
}

const updateRelease = ({ context, release, releaseInfo }) => {
  const updateReleaseParameters = updateDraftReleaseParameters({
    name: releaseInfo.name || release.name,
    tag_name: releaseInfo.tag || release.tag_name,
    target_commitish: releaseInfo.targetCommitish,
  })

  return context.octokit.repos.updateRelease(
    context.repo({
      release_id: release.id,
      body: releaseInfo.body,
      draft: releaseInfo.draft,
      prerelease: releaseInfo.prerelease,
      make_latest: releaseInfo.make_latest,
      ...updateReleaseParameters,
    })
  )
}

function updateDraftReleaseParameters(parameters) {
  const updateReleaseParameters = { ...parameters }

  // Let GitHub figure out `name` and `tag_name` if undefined
  if (!updateReleaseParameters.name) {
    delete updateReleaseParameters.name
  }
  if (!updateReleaseParameters.tag_name) {
    delete updateReleaseParameters.tag_name
  }

  // Keep existing `target_commitish` if not overriden
  // (sending `null` resets it to the default branch)
  if (!updateReleaseParameters.target_commitish) {
    delete updateReleaseParameters.target_commitish
  }

  return updateReleaseParameters
}

exports.findReleases = findReleases
exports.generateChangeLog = generateChangeLog
exports.generateReleaseInfo = generateReleaseInfo
exports.createRelease = createRelease
exports.updateRelease = updateRelease
