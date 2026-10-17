/*
 Navicat Premium Data Transfer

 Source Server Type    : MySQL
 Source Server Version : 80031
 Source Schema         : music

 按示例 ER 图反推的音乐 App 建表脚本（学生项目常见写法：没有声明外键，靠 xxx_id 关联）
*/

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- Table structure for user
-- ----------------------------
DROP TABLE IF EXISTS `user`;
CREATE TABLE `user`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',
  `username` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '用户名',
  `password` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '密码',
  `phone` varchar(20) NULL DEFAULT NULL COMMENT '手机号',
  `email` varchar(100) NULL DEFAULT NULL COMMENT '邮箱',
  `gender` tinyint NULL DEFAULT NULL COMMENT '性别 0女 1男',
  `birthday` date NULL DEFAULT NULL COMMENT '生日',
  `avatar` varchar(255) NULL DEFAULT NULL COMMENT '头像路径',
  `preferred_style` varchar(50) NULL DEFAULT NULL COMMENT '偏好风格',
  `status` tinyint NULL DEFAULT 1 COMMENT '状态：0禁用 1正常',
  `create_time` datetime NULL DEFAULT CURRENT_TIMESTAMP COMMENT '注册时间',
  `update_time` datetime NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_username`(`username` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 1 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_general_ci COMMENT = '用户表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for admin
-- ----------------------------
DROP TABLE IF EXISTS `admin`;
CREATE TABLE `admin`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',
  `username` varchar(50) NOT NULL COMMENT '用户名',
  `password` varchar(100) NOT NULL COMMENT '密码',
  `last_login_time` datetime NULL DEFAULT NULL COMMENT '最后登录时间',
  `create_time` datetime NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COMMENT = '管理员表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for song
-- ----------------------------
DROP TABLE IF EXISTS `song`;
CREATE TABLE `song`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',
  `name` varchar(255) NOT NULL COMMENT '歌曲名',
  `singer` varchar(100) NULL DEFAULT NULL COMMENT '歌手',
  `style_tags` varchar(255) NULL DEFAULT NULL COMMENT '风格标签，逗号分隔',
  `duration` int NULL DEFAULT NULL COMMENT '时长（秒）',
  `audio_path` varchar(255) NOT NULL COMMENT '音频文件路径',
  `lyric_path` varchar(255) NULL DEFAULT NULL COMMENT '歌词文件路径',
  `cover_path` varchar(255) NULL DEFAULT NULL COMMENT '封面图路径',
  `play_count` int NULL DEFAULT 0 COMMENT '播放次数',
  `status` tinyint NULL DEFAULT 1 COMMENT '状态：0下架 1上架',
  `create_time` datetime NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `update_time` datetime NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`) USING BTREE,
  INDEX `idx_name`(`name` ASC) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COMMENT = '歌曲表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for playlist
-- ----------------------------
DROP TABLE IF EXISTS `playlist`;
CREATE TABLE `playlist`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',
  `name` varchar(100) NOT NULL COMMENT '歌单名称',
  `description` varchar(500) NULL DEFAULT NULL COMMENT '歌单描述',
  `cover_path` varchar(255) NULL DEFAULT NULL COMMENT '歌单封面路径',
  `song_count` int NULL DEFAULT 0 COMMENT '歌曲数量',
  `play_count` int NULL DEFAULT 0 COMMENT '歌单播放次数',
  `is_public` tinyint NULL DEFAULT 1 COMMENT '是否公开 0否 1是',
  `create_time` datetime NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `update_time` datetime NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COMMENT = '歌单表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for playlist_song
-- ----------------------------
DROP TABLE IF EXISTS `playlist_song`;
CREATE TABLE `playlist_song`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',
  `playlist_id` bigint NOT NULL COMMENT '歌单ID',
  `song_id` bigint NOT NULL COMMENT '歌曲ID',
  `sort_no` int NULL DEFAULT 0 COMMENT '排序序号',
  `add_time` datetime NULL DEFAULT CURRENT_TIMESTAMP COMMENT '添加时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_playlist_song`(`playlist_id` ASC, `song_id` ASC) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COMMENT = '歌单歌曲关联表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for user_favorite_playlist
-- ----------------------------
DROP TABLE IF EXISTS `user_favorite_playlist`;
CREATE TABLE `user_favorite_playlist`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id` bigint NOT NULL COMMENT '用户ID',
  `playlist_id` bigint NOT NULL COMMENT '歌单ID',
  `favorite_time` datetime NULL DEFAULT CURRENT_TIMESTAMP COMMENT '收藏时间',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COMMENT = '用户收藏歌单表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for play_history
-- ----------------------------
DROP TABLE IF EXISTS `play_history`;
CREATE TABLE `play_history`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id` bigint NOT NULL COMMENT '用户ID',
  `song_id` bigint NOT NULL COMMENT '歌曲ID',
  `progress` int NULL DEFAULT 0 COMMENT '播放进度（秒）',
  `play_time` datetime NULL DEFAULT CURRENT_TIMESTAMP COMMENT '播放时间',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COMMENT = '播放记录表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for listening_report
-- ----------------------------
DROP TABLE IF EXISTS `listening_report`;
CREATE TABLE `listening_report`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id` bigint NOT NULL COMMENT '用户ID',
  `report_date` date NOT NULL COMMENT '报告日期',
  `total_play_count` int NULL DEFAULT 0 COMMENT '总播放次数',
  `total_duration` int NULL DEFAULT 0 COMMENT '总听歌时长（分钟）',
  `favorite_song` varchar(255) NULL DEFAULT NULL COMMENT '最爱歌曲',
  `favorite_singer` varchar(100) NULL DEFAULT NULL COMMENT '最爱歌手',
  `favorite_style` varchar(50) NULL DEFAULT NULL COMMENT '最爱风格',
  `peak_period` varchar(50) NULL DEFAULT NULL COMMENT '听歌高峰时段',
  `ai_comment` text NULL COMMENT 'AI生成评价',
  `create_time` datetime NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生成时间',
  PRIMARY KEY (`id`) USING BTREE,
  INDEX `idx_user_date`(`user_id` ASC, `report_date` ASC) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COMMENT = '听歌报告表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for ai_model_config
-- ----------------------------
DROP TABLE IF EXISTS `ai_model_config`;
CREATE TABLE `ai_model_config`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',
  `model_name` varchar(100) NOT NULL COMMENT '模型名称',
  `model_type` varchar(50) NULL DEFAULT NULL COMMENT '模型类型',
  `api_endpoint` varchar(255) NULL DEFAULT NULL COMMENT 'API端点',
  `api_key` varchar(255) NULL DEFAULT NULL COMMENT 'API密钥',
  `model_path` varchar(255) NULL DEFAULT NULL COMMENT '模型路径',
  `create_time` datetime NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `update_time` datetime NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COMMENT = 'AI模型配置表' ROW_FORMAT = Dynamic;

SET FOREIGN_KEY_CHECKS = 1;
