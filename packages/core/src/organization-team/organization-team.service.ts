import {
	Injectable,
	BadRequestException,
	UnauthorizedException,
	ForbiddenException
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, ILike, SelectQueryBuilder, DeleteResult, IsNull } from 'typeorm';
import {
	IOrganizationTeamCreateInput,
	IOrganizationTeam,
	RolesEnum,
	IPagination,
	IOrganizationTeamUpdateInput,
	IEmployee,
	PermissionsEnum,
	IBasePerTenantAndOrganizationEntityModel,
	IUser
} from '@gauzy/contracts';
import { isNotEmpty } from '@gauzy/common';
import { Employee, OrganizationTeamEmployee } from './../core/entities/internal';
import { OrganizationTeam } from './organization-team.entity';
import { PaginationParams, TenantAwareCrudService } from './../core/crud';
import { RequestContext } from '../core/context';
import { RoleService } from '../role/role.service';
import { UserService } from './../user/user.service';
import { OrganizationTeamEmployeeService } from '../organization-team-employee/organization-team-employee.service';

@Injectable()
export class OrganizationTeamService extends TenantAwareCrudService<OrganizationTeam> {

	constructor(
		@InjectRepository(OrganizationTeam) protected readonly organizationTeamRepository: Repository<OrganizationTeam>,
		@InjectRepository(Employee) private readonly employeeRepository: Repository<Employee>,
		private readonly roleService: RoleService,
		private readonly organizationTeamEmployeeService: OrganizationTeamEmployeeService,
		private readonly userService: UserService
	) {
		super(organizationTeamRepository);
	}

	async create(
		entity: IOrganizationTeamCreateInput
	): Promise<IOrganizationTeam> {
		const { tags = [], memberIds = [], managerIds = [] } = entity;
		const { name, organizationId, prefix, profile_link, logo } = entity;

		try {
			const tenantId = RequestContext.currentTenantId();
			/**
			 * If, employee create teams, default add as a manager
			 */
			try {
				await this.roleService.findOneByIdString(RequestContext.currentRoleId(), {
					where: {
						name: RolesEnum.EMPLOYEE
					}
				});

				const employeeId = RequestContext.currentEmployeeId();
				if (!managerIds.includes(employeeId)) {
					managerIds.push(employeeId);
				}
			} catch (error) { }

			const employees = await this.employeeRepository.find({
				where: {
					id: In([...memberIds, ...managerIds]),
					organizationId,
					tenantId
				},
				relations: {
					user: true
				}
			});

			/**
			 * Get manager role
			 */
			const manager = await this.roleService.findOneByWhereOptions({
				name: RolesEnum.MANAGER
			});

			const members: OrganizationTeamEmployee[] = [];
			employees.forEach((employee: IEmployee) => {
				const employeeId = employee.id;
				members.push(new OrganizationTeamEmployee({
					employeeId,
					organizationId,
					tenantId,
					role: managerIds.includes(employeeId) ? manager : null
				}));
			});
			return await super.create({
				tags,
				organizationId,
				tenantId,
				name,
				prefix,
				members,
				profile_link,
				public: entity.public,
				logo
			});
		} catch (error) {
			throw new BadRequestException(`Failed to create a team: ${error}`);
		}
	}

	async update(
		id: IOrganizationTeam['id'],
		entity: IOrganizationTeamUpdateInput
	): Promise<OrganizationTeam> {

		const tenantId = RequestContext.currentTenantId();
		const { memberIds, managerIds } = entity;
		const { name, prefix, organizationId, tags, logo } = entity;

		let organizationTeam = await this.findOneByIdString(id, {
			where: {
				organizationId,
				tenantId
			}
		});

		/**
		 * If employee has manager of the team, he/she should be able to update basic things for team
		 */
		if (!RequestContext.hasPermission(
			PermissionsEnum.CHANGE_SELECTED_EMPLOYEE
		)) {
			try {
				const employeeId = RequestContext.currentEmployeeId();
				if (employeeId) {
					organizationTeam = await this.findOneByIdString(id, {
						where: {
							organizationId,
							tenantId,
							members: {
								employeeId,
								tenantId,
								organizationId,
								role: {
									name: RolesEnum.MANAGER
								}
							}
						}
					});
				}
			} catch (error) {
				throw new ForbiddenException();
			}
		}

		try {
			if (isNotEmpty(memberIds) || isNotEmpty(managerIds)) {
				/**
				 * Get manager role
				 */
				const role = await this.roleService.findOneByWhereOptions({
					name: RolesEnum.MANAGER
				});

				const employees = await this.employeeRepository.find({
					where: {
						id: In([...memberIds, ...managerIds]),
						organizationId,
						tenantId
					},
					relations: {
						user: true
					}
				});

				// Update nested entity
				await this.organizationTeamEmployeeService.updateOrganizationTeam(
					id,
					organizationId,
					employees,
					role,
					managerIds,
					memberIds
				);
			}

			this.repository.merge(organizationTeam, { name, tags, prefix, public: entity.public, logo });
			return await this.repository.save(organizationTeam);
		} catch (err /*: WriteError*/) {
			throw new BadRequestException(err);
		}
	}

	/**
	 * Find my teams
	 *
	 * @param params
	 * @returns
	 */
	public async findMyTeams(
		options: PaginationParams<OrganizationTeam>
	): Promise<IPagination<OrganizationTeam>> {
		try {
			return await this.findAll(options);
		} catch (error) {
			throw new UnauthorizedException();
		}
	}

	/**
	 * GET organization teams pagination by params
	 *
	 * @param filter
	 * @returns
	 */
	public async pagination(
		options?: PaginationParams<OrganizationTeam>
	): Promise<IPagination<OrganizationTeam>> {
		if ('where' in options) {
			const { where } = options;
			if ('name' in where) {
				options['where']['name'] = ILike(`%${where.name}%`);
			}
			if ('tags' in where) {
				options['where']['tags'] = {
					id: In(where.tags as [])
				}
			}
		}
		return await this.findAll(options);
	}

	/**
	 * GET organization teams by params
	 *
	 * @param options
	 * @returns
	 */
	public async findAll(
		options?: PaginationParams<OrganizationTeam>
	): Promise<IPagination<OrganizationTeam>> {
		const tenantId = RequestContext.currentTenantId();
		const employeeId = RequestContext.currentEmployeeId();

		const members = options.where.members;
		if ('members' in options.where) { delete options.where['members']; }

		const query = this.repository.createQueryBuilder(this.alias);
		// If employee has login and don't have permission to change employee
		if (employeeId && !RequestContext.hasPermission(
			PermissionsEnum.CHANGE_SELECTED_EMPLOYEE
		)) {
			// Sub query to get only employee assigned teams
			query.andWhere((cb: SelectQueryBuilder<OrganizationTeam>) => {
				const subQuery = cb.subQuery().select('"team"."organizationTeamId"').from('organization_team_employee', 'team');
				subQuery.andWhere(`"${query.alias}"."tenantId" = :tenantId`, { tenantId });

				if (isNotEmpty(options) && isNotEmpty(options.where)) {
					const { organizationId } = options.where;
					subQuery.andWhere(`"${query.alias}"."organizationId" = :organizationId`, { organizationId });
				}

				subQuery.andWhere('"team"."employeeId" = :employeeId', { employeeId });
				return '"organization_team"."id" IN ' + subQuery.distinct(true).getQuery();
			});
		} else {
			if (isNotEmpty(members) && isNotEmpty(members['employeeId'])) {
				// Sub query to get only employee assigned teams
				query.andWhere((cb: SelectQueryBuilder<OrganizationTeam>) => {
					const subQuery = cb.subQuery().select('"team"."organizationTeamId"').from('organization_team_employee', 'team');
					subQuery.andWhere(`"${query.alias}"."tenantId" = :tenantId`, { tenantId });

					if (isNotEmpty(options) && isNotEmpty(options.where)) {
						const { organizationId } = options.where;
						subQuery.andWhere(`"${query.alias}"."organizationId" = :organizationId`, { organizationId });
					}

					const employeeId = members['employeeId'];
					subQuery.andWhere('"team"."employeeId" = :employeeId', { employeeId });
					return '"organization_team"."id" IN ' + subQuery.distinct(true).getQuery();
				});
			}
		}
		if (isNotEmpty(options)) {
			query.setFindOptions({
				skip: options.skip ? (options.take * (options.skip - 1)) : 0,
				take: options.take ? (options.take) : 10
			});
			query.setFindOptions({
				...(
					(options.select) ? { select: options.select } : {}
				),
				...(
					(options.relations) ? { relations: options.relations } : {}
				),
				...(
					(options.where) ? { where: options.where } : {}
				),
				...(
					(options.order) ? { order: options.order } : {}
				)
			});
		}
		query.andWhere(`"${query.alias}"."tenantId" = :tenantId`, { tenantId });
		const [items, total] = await query.getManyAndCount();
		return { items, total };
	}

	/**
	 * Delete organization team
	 *
	 * @param teamId
	 * @param options
	 * @returns
	 */
	async deleteTeam(
		teamId: IOrganizationTeam['id'],
		options: IBasePerTenantAndOrganizationEntityModel
	): Promise<DeleteResult | IOrganizationTeam> {
		try {
			const { organizationId } = options;
			const team = await this.findOneByIdString(teamId, {
				where: {
					tenantId: RequestContext.currentTenantId(),
					organizationId,
					...(
						(!RequestContext.hasPermission(PermissionsEnum.CHANGE_SELECTED_EMPLOYEE)) ? {
							members: {
								employeeId: RequestContext.currentEmployeeId(),
								role: {
									name: RolesEnum.MANAGER
								}
							}
						} : {}
					)
				}
			});
			return await this.repository.remove(team);
		} catch (error) {
			throw new ForbiddenException();
		}
	}

	/**
	 * Exist from teams where users joined as a team members.
	 *
	 * @param criteria
	 * @param options
	 */
	public async existTeamsAsMember(criteria: IUser['id']): Promise<DeleteResult> {
		const userId = RequestContext.currentUserId();

		// If user don't have enough permission (CHANGE_SELECTED_EMPLOYEE).
		if (!RequestContext.hasPermission(PermissionsEnum.CHANGE_SELECTED_EMPLOYEE)) {
			// If user try to delete someone other user account, just denied the request.
			if (userId != criteria) {
				throw new ForbiddenException('You can not removed account for other members!');
			}
		}

		const user = await this.userService.findOneByIdString(criteria, {
			relations: {
				employee: true
			}
		});
		if (!!user) {
			const { employeeId } = user;
			try {
				if (isNotEmpty(employeeId)) {
					await this.organizationTeamEmployeeService.findOneByWhereOptions({
						employeeId,
						roleId: IsNull()
					});
					return await this.organizationTeamEmployeeService.delete({
						roleId: IsNull(),
						employeeId
					});
				}
			} catch (error) {
				throw new ForbiddenException('You are not able to removed account where you are only the manager!');
			}
		}
		throw new ForbiddenException();
	}
}
