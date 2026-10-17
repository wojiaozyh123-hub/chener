"""博客示例：SQLAlchemy 2.0 写法（mixin 继承列、Mapped 注解、模块级关联表、自引用、一对一）。"""

from datetime import datetime
from typing import List, Optional

from sqlalchemy import Column, ForeignKey, String, Table, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(default=datetime.now, comment="创建时间")
    updated_at: Mapped[datetime] = mapped_column(default=datetime.now, onupdate=datetime.now, comment="更新时间")


post_tag = Table(
    "post_tag",
    Base.metadata,
    Column("post_id", ForeignKey("post.id"), primary_key=True),
    Column("tag_id", ForeignKey("tag.id"), primary_key=True),
    comment="文章标签关联",
)


class User(TimestampMixin, Base):
    """用户"""

    __tablename__ = "user"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, comment="用户名")
    nickname: Mapped[Optional[str]] = mapped_column(String(50))  # 昵称
    email: Mapped[str] = mapped_column(String(120), comment="邮箱")

    posts: Mapped[List["Post"]] = relationship(back_populates="author")


class Profile(Base):
    __tablename__ = "profile"
    __table_args__ = {"comment": "用户资料"}

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("user.id"), unique=True, comment="用户ID")
    bio: Mapped[Optional[str]] = mapped_column(Text, comment="个人简介")
    avatar: Mapped[Optional[str]] = mapped_column(String(255), comment="头像")


class Category(Base):
    __tablename__ = "category"
    __table_args__ = {"comment": "分类"}

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(50), comment="分类名")
    parent_id: Mapped[Optional[int]] = mapped_column(ForeignKey("category.id"), comment="上级分类ID")


class Post(TimestampMixin, Base):
    __tablename__ = "post"
    __table_args__ = {"comment": "文章"}

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200), comment="标题")
    content: Mapped[str] = mapped_column(Text, comment="正文")
    author_id: Mapped[int] = mapped_column(ForeignKey("user.id"), comment="发布人ID")
    category_id: Mapped[Optional[int]] = mapped_column(ForeignKey("category.id"), comment="所属分类ID")
    view_count: Mapped[int] = mapped_column(default=0, comment="阅读量")

    author: Mapped["User"] = relationship(back_populates="posts")
    tags: Mapped[List["Tag"]] = relationship(secondary=post_tag)


class Tag(Base):
    __tablename__ = "tag"
    __table_args__ = {"comment": "标签"}

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(30), unique=True, comment="标签名")


class Comment(Base):
    __tablename__ = "comment"
    __table_args__ = {"comment": "评论"}

    id: Mapped[int] = mapped_column(primary_key=True)
    post_id: Mapped[int] = mapped_column(ForeignKey("post.id"), comment="文章ID")
    user_id: Mapped[int] = mapped_column(ForeignKey(User.id), comment="评论人ID")
    content: Mapped[str] = mapped_column(Text, comment="评论内容")
    created_at: Mapped[datetime] = mapped_column(default=datetime.now, comment="评论时间")
