export function createActivityService({ activityRepo }) {
  async function log({ organizationId, userId, actionType, entityType, description }) {
    return activityRepo.log({ organizationId, userId, actionType, entityType, description });
  }

  async function getRecent(organizationId, limit = 10) {
    return activityRepo.getRecent(organizationId, limit);
  }

  return { log, getRecent };
}
