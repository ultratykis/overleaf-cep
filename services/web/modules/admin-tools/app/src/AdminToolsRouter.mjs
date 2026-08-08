import logger from '@overleaf/logger'
import UserListController from './UserListController.mjs'
import ProjectListController from './ProjectListController.mjs'
import AdminToolsController from './AdminToolsController.mjs'
import AiReviewerHistoryAdminController from './AiReviewerHistoryAdminController.mjs'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AdminAuthorizationHelper from '../../../../app/src/Features/Helpers/AdminAuthorizationHelper.mjs'
import HttpErrorHandler from '../../../../app/src/Features/Errors/HttpErrorHandler.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'

const aiReviewerHistoryRateLimiter = new RateLimiter(
  'ai-reviewer-history-admin',
  { points: 10, duration: 60 }
)
const rateLimitAiReviewerHistory = RateLimiterMiddleware.rateLimit(
  aiReviewerHistoryRateLimiter
)

export function ensureAiReviewerHistoryPurgeCapability(req, res, next) {
  if (
    AdminAuthorizationHelper.hasAdminCapability(
      'ai-reviewer-history-purge',
      false
    )(req)
  ) {
    return next()
  }
  return HttpErrorHandler.notFound(req, res)
}

const aiReviewerHistoryMiddleware = [
  AuthorizationMiddleware.ensureUserIsSiteAdmin,
  ensureAiReviewerHistoryPurgeCapability,
  rateLimitAiReviewerHistory,
]

export default {
  apply(webRouter) {
    logger.debug({}, 'Init AdminTools router')

    webRouter.get('/user/activate', UserListController.activateAccountPage)
    AuthenticationController.addEndpointToLoginWhitelist('/user/activate')

    webRouter.get('/admin/user',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserListController.manageUsersPage
    )
    webRouter.post(
      '/admin/user/create',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserListController.registerNewUser
    )
    webRouter.post('/admin/user/:userId/send-activation',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserListController.sendActivationEmail
    )
    webRouter.get('/admin/user/:userId/info',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserListController.getAdditionalUserInfo,
    )
    webRouter.post('/admin/users',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserListController.getUsersJson
    )
    webRouter.post('/admin/user/:userId/delete',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserListController.deleteUser
    )
    webRouter.post('/admin/user/:userId/update',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserListController.updateUser,
    )
    webRouter.delete('/admin/user/:userId',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserListController.purgeDeletedUser
    )
    webRouter.post('/admin/user/:userId/restore',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      UserListController.restoreDeletedUser
    )
    webRouter.post('/admin/user/:userId/projects',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      ProjectListController.getProjectsJson
    )

    webRouter.get('/admin/project',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      ProjectListController.manageProjectsPage
    )
    webRouter.post('/admin/project/:project_id/trash',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      ProjectListController.trashProjectForUser
    )
    webRouter.post('/admin/project/:project_id/untrash',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      ProjectListController.untrashProjectForUser
    )
    webRouter.delete('/admin/project/:project_id/purge',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      ProjectListController.purgeDeletedProject
    )
    webRouter.delete('/admin/project/:project_id',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      ProjectListController.deleteProject
    )
    webRouter.post('/admin/project/:project_id/undelete',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      ProjectListController.undeleteProject
    )

    webRouter.get('/admin/active-projects',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminToolsController.activeProjects,
    )

    webRouter.get(
      '/admin/ai-reviewer/history',
      ...aiReviewerHistoryMiddleware,
      AiReviewerHistoryAdminController.show
    )
    webRouter.post(
      '/admin/ai-reviewer/history/dry-run',
      ...aiReviewerHistoryMiddleware,
      AiReviewerHistoryAdminController.dryRun
    )
    webRouter.post(
      '/admin/ai-reviewer/history/purge',
      ...aiReviewerHistoryMiddleware,
      AiReviewerHistoryAdminController.purge
    )
  },
}
